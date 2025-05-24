import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { client } from "../index.js";
import { channelService } from "./channelService.js";
import { retryWithBackoff } from "../utils/retry.js";
import { EMBED_COLORS } from "../config/constants.js";

export const messageService = {
  // Cache for webhooks to avoid recreating them
  webhookCache: new Map(),

  /**
   * RELAY MESSAGES - Forward messages between servers via webhooks
   */
  async relayMessage(message, channel) {
    const channelInfo = channelService.getChannelInfo(channel.id);
    const targetServers = channelService.getAllServersWithout(
      message.guildId,
      channelInfo.channel_type
    );

    if (targetServers.length === 0) {
      console.log("No target servers found for message relay");
      return { total: 0, successful: 0, failed: 0 };
    }

    console.log(`📤 Forwarding message to ${targetServers.length} servers...`);

    return await this.forwardToServers(
      message,
      channelInfo,
      targetServers,
      message.guild
    );
  },

  async forwardToServers(message, channelInfo, targetServers, sourceGuild) {
    const results = {
      total: targetServers.length,
      successful: 0,
      failed: 0,
      forwardSent: 0,
      failedServers: [],
    };

    const sendPromises = targetServers.map((server) =>
      this.forwardMessageToServer(server, message, channelInfo, sourceGuild)
        .then((result) => {
          if (result.success) {
            results.successful++;
            results.forwardSent++;
          } else {
            results.failed++;
            results.failedServers.push({
              serverId: result.serverId,
              error: result.error,
            });
          }
          return result;
        })
        .catch((error) => {
          console.error("Unexpected error in forwardMessageToServer:", error);
          results.failed++;
          results.failedServers.push({
            serverId: server.server_id,
            error: error.message,
          });
          return { success: false, error: error.message, serverId: server.server_id };
        })
    );

    await Promise.all(sendPromises);
    return results;
  },

  async forwardMessageToServer(server, message, channelInfo, originalGuild) {
    const serverId = server.server_id;
    const serverName = `Server ${serverId}`;

    try {
      const role = channelService.getRoleFromServerAndType(
        serverId,
        channelInfo.channel_type
      );
      
      if (!role) {
        throw new Error(
          `No role found for server ${serverId} and type ${channelInfo.channel_type}`
        );
      }

      const outputChannel = client.channels.cache.get(server.channel_id_output);
      if (!outputChannel) {
        throw new Error(`Could not find output channel ${server.channel_id_output}`);
      }

      // Use centralized webhook sending
      const sentMessage = await this.sendViaWebhook(outputChannel, {
        content: `<@&${role.role_id}>`,
        username: originalGuild.name,
        avatarURL: originalGuild.iconURL({ dynamic: true, size: 256 }),
        originalMessage: message,
        sourceGuild: originalGuild
      });

      console.log(
        `✅ Message forwarded via webhook to ${outputChannel.name} in ${serverName} (ID: ${sentMessage.id})`
      );

      return { success: true, method: "webhook", messageId: sentMessage.id };
    } catch (error) {
      console.error(
        `❌ Failed to forward message to ${serverName}:`,
        error.message
      );
      return { success: false, error: error.message, serverId };
    }
  },

  /**
   * INTERACTION RESPONSES - Standardized command responses
   */
  async sendInteractionResponse(interaction, options) {
    const messageData = this.formatInteractionMessage(options);
    
    try {
      if (interaction.deferred || interaction.replied) {
        return await interaction.editReply(messageData);
      } else {
        return await interaction.reply({ ...messageData, ephemeral: options.ephemeral ?? true });
      }
    } catch (error) {
      console.error("Failed to send interaction response:", error);
      throw error;
    }
  },

  async sendSuccessResponse(interaction, message, options = {}) {
    return await this.sendInteractionResponse(interaction, {
      type: 'success',
      message,
      ...options
    });
  },

  async sendErrorResponse(interaction, message, options = {}) {
    return await this.sendInteractionResponse(interaction, {
      type: 'error',
      message,
      ...options
    });
  },

  async sendInfoResponse(interaction, message, options = {}) {
    return await this.sendInteractionResponse(interaction, {
      type: 'info',
      message,
      ...options
    });
  },

  async sendWarningResponse(interaction, message, options = {}) {
    return await this.sendInteractionResponse(interaction, {
      type: 'warning',
      message,
      ...options
    });
  },

  /**
   * DIRECT CHANNEL MESSAGING - Send messages to specific channels
   */
  async sendToChannel(channel, options) {
    const messageData = this.formatChannelMessage(options);
    
    return await retryWithBackoff(
      () => channel.send(messageData),
      `Sending message to ${channel.name}`
    );
  },

  async sendViaWebhook(channel, options) {
    const webhook = await this.getOrCreateWebhook(channel);
    const webhookData = await this.formatWebhookMessage(options);
    
    return await retryWithBackoff(
      () => webhook.send(webhookData),
      `Sending webhook message to ${channel.name}`
    );
  },

  /**
   * MESSAGE FORMATTING - Standardized message formatting
   */
  formatInteractionMessage(options) {
    const { type, message, title, description, fields, embeds = [] } = options;
    
    let content = '';
    const messageEmbeds = [...embeds];

    // Add status embed based on type
    if (type) {
      const statusEmbed = new EmbedBuilder()
        .setColor(this.getColorForType(type))
        .setDescription(message);

      if (title) statusEmbed.setTitle(title);
      if (description && description !== message) statusEmbed.addFields({ name: 'Details', value: description });
      if (fields) statusEmbed.addFields(fields);
      
      statusEmbed.setTimestamp();
      messageEmbeds.unshift(statusEmbed);
    } else {
      content = message;
    }

    return {
      content: content || undefined,
      embeds: messageEmbeds.length > 0 ? messageEmbeds : undefined
    };
  },

  formatChannelMessage(options) {
    const { content, embeds = [], files = [] } = options;
    
    return {
      content: content || undefined,
      embeds: embeds.length > 0 ? embeds : undefined,
      files: files.length > 0 ? files : undefined
    };
  },

  async formatWebhookMessage(options) {
    const { content, username, avatarURL, originalMessage, sourceGuild, embeds = [] } = options;
    
    const webhookData = {
      content,
      username,
      avatarURL,
      files: [],
      embeds: [...embeds]
    };

    // Handle original message data if provided
    if (originalMessage) {
      // Add original message content
      if (originalMessage.content && originalMessage.content.trim()) {
        webhookData.content += originalMessage.content ? `\n${originalMessage.content}` : '';
      }

      // Handle embeds from original message
      if (originalMessage.embeds && originalMessage.embeds.length > 0) {
        webhookData.embeds.push(...this.prepareEmbeds(originalMessage.embeds));
        
        // Add footer to first embed with source channel info
        if (webhookData.embeds[0]) {
          const firstEmbed = webhookData.embeds[0];
          if (!firstEmbed.footer) {
            firstEmbed.footer = {};
          }
          const channelInfo = `#${originalMessage.channel.name}`;
          firstEmbed.footer.text = firstEmbed.footer.text
            ? `${channelInfo} • ${firstEmbed.footer.text}`
            : channelInfo;
        }
      }

      // Handle attachments - AWAIT this async call
      webhookData.files = await this.prepareAttachments(originalMessage);
    }

    // Ensure we have some content
    if (!webhookData.content.trim() && 
        webhookData.embeds.length === 0 && 
        webhookData.files.length === 0) {
      webhookData.content = "*(Empty message)*";
    }

    return webhookData;
  },

  /**
   * UTILITY METHODS
   */
  getColorForType(type) {
    const colors = {
      success: EMBED_COLORS.success,
      error: EMBED_COLORS.error,
      warning: EMBED_COLORS.warning,
      info: EMBED_COLORS.default
    };
    return colors[type] || EMBED_COLORS.default;
  },

  async getOrCreateWebhook(channel) {
    const cacheKey = channel.id;
    
    // Check cache first
    if (this.webhookCache.has(cacheKey)) {
      const cachedWebhook = this.webhookCache.get(cacheKey);
      try {
        // Test if webhook still exists
        await cachedWebhook.fetch();
        return cachedWebhook;
      } catch (error) {
        // Webhook was deleted, remove from cache
        this.webhookCache.delete(cacheKey);
      }
    }

    try {
      // Look for existing webhook created by this bot
      const webhooks = await channel.fetchWebhooks();
      let webhook = webhooks.find(wh => wh.name === 'Erinnounce Relay' && wh.owner.id === client.user.id);
      
      if (!webhook) {
        // Create new webhook
        webhook = await channel.createWebhook({
          name: 'Erinnounce Relay',
          reason: 'Webhook for message relaying between servers'
        });
        console.log(`📎 Created new webhook in #${channel.name}`);
      }

      // Cache the webhook
      this.webhookCache.set(cacheKey, webhook);
      return webhook;
    } catch (error) {
      throw new Error(`Failed to get or create webhook: ${error.message}`);
    }
  },

  prepareEmbeds(embeds) {
    return embeds.map((originalEmbed) => {
      return this.copyEmbed(originalEmbed);
    });
  },

  copyEmbed(originalEmbed) {
    const embed = {
      title: originalEmbed.title || undefined,
      description: originalEmbed.description || undefined,
      url: originalEmbed.url || undefined,
      color: originalEmbed.color || undefined,
      timestamp: originalEmbed.timestamp || undefined,
      fields: originalEmbed.fields ? [...originalEmbed.fields] : undefined,
      author: originalEmbed.author ? {
        name: originalEmbed.author.name,
        url: originalEmbed.author.url,
        icon_url: originalEmbed.author.iconURL || originalEmbed.author.icon_url,
      } : undefined,
      thumbnail: originalEmbed.thumbnail ? {
        url: originalEmbed.thumbnail.url,
      } : undefined,
      image: originalEmbed.image ? {
        url: originalEmbed.image.url,
      } : undefined,
      footer: originalEmbed.footer ? {
        text: originalEmbed.footer.text,
        icon_url: originalEmbed.footer.iconURL || originalEmbed.footer.icon_url,
      } : undefined,
    };

    // Remove undefined properties
    Object.keys(embed).forEach((key) => {
      if (embed[key] === undefined) {
        delete embed[key];
      }
    });

    return embed;
  },

  async prepareAttachments(message) {
    const attachments = [];

    if (message.attachments && message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        try {
          attachments.push(
            new AttachmentBuilder(attachment.url, { name: attachment.name })
          );
        } catch (error) {
          console.warn(
            `Failed to prepare attachment ${attachment.name}:`,
            error.message
          );
        }
      }
    }

    return attachments;
  }
};