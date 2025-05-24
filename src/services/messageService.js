import { AttachmentBuilder } from "discord.js";
import { client } from "../index.js";
import { channelService } from "./channelService.js";
import { retryWithBackoff } from "../utils/retry.js";
import { EMBED_COLORS } from "../config/constants.js";

export const messageService = {
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

      const forwardData = await this.prepareForwardData(
        message,
        role,
        originalGuild
      );

      const sentMessage = await retryWithBackoff(
        () => outputChannel.send(forwardData),
        `Forwarding message to ${outputChannel.name} in ${serverName}`
      );

      console.log(
        `✅ Message forwarded to ${outputChannel.name} in ${serverName} (ID: ${sentMessage.id})`
      );

      return { success: true, method: "forward", messageId: sentMessage.id };
    } catch (error) {
      console.error(
        `❌ Failed to forward message to ${serverName}:`,
        error.message
      );
      return { success: false, error: error.message, serverId };
    }
  },

  async prepareForwardData(message, role, originalGuild) {
    const baseContent = `<@&${role.role_id}> **From ${originalGuild.name}:**`;
    
    const forwardData = {
      content: baseContent,
      embeds: [],
      files: await this.prepareAttachments(message),
    };

    // Add message content
    if (message.content && message.content.trim()) {
      forwardData.content += `\n${message.content}`;
    }

    // Handle embeds
    if (message.embeds && message.embeds.length > 0) {
      forwardData.embeds = this.prepareEmbeds(message.embeds, originalGuild);
    } else {
      // Create source info embed if no embeds present
      forwardData.embeds.push({
        color: EMBED_COLORS.default,
        author: {
          name: `${message.author.username} in ${originalGuild.name}`,
          icon_url: message.author.displayAvatarURL(),
        },
        timestamp: message.createdAt.toISOString(),
        footer: {
          text: `Forwarded from #${message.channel.name}`,
        },
      });
    }

    // Ensure non-empty message
    if (
      !forwardData.content.trim() &&
      forwardData.embeds.length === 0 &&
      forwardData.files.length === 0
    ) {
      forwardData.content = `${baseContent} *(Message with attachments)*`;
    }

    return forwardData;
  },

  prepareEmbeds(embeds, originalGuild) {
    return embeds.map((originalEmbed, index) => {
      const forwardedEmbed = this.copyEmbed(originalEmbed);
      
      // Add source info to first embed
      if (index === 0) {
        if (!forwardedEmbed.footer) {
          forwardedEmbed.footer = {};
        }
        
        const sourceInfo = `Forwarded from ${originalGuild.name}`;
        forwardedEmbed.footer.text = forwardedEmbed.footer.text
          ? `${sourceInfo} • ${forwardedEmbed.footer.text}`
          : sourceInfo;
      }
      
      return forwardedEmbed;
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