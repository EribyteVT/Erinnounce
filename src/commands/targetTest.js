import { client } from "../index.js";
import { channelService } from "../services/channelService.js";
import { messageService } from "../services/messageService.js";
import { containsLink } from "../utils/linkDetection.js";
import { debugMessage } from "../utils/messageDebug.js";
import { DEFAULT_AVATAR, EMBED_COLORS } from "../config/constants.js";

export async function handleTargetTestCommand(interaction) {
  const fromServerId = interaction.options.getString("from_server_id");
  const fromChannelId = interaction.options.getString("from_channel_id");
  const targetChannelId = interaction.options.getString("target_channel_id");
  const messageContent = interaction.options.getString("message_content") || 
    "Target test message with link: https://example.com";
  const testEmbed = interaction.options.getBoolean("test_embed") ?? false;

  await interaction.deferReply({ ephemeral: true });

  try {
    // Validate IDs format
    if (!/^\d{17,19}$/.test(fromServerId) || 
        !/^\d{17,19}$/.test(fromChannelId) || 
        !/^\d{17,19}$/.test(targetChannelId)) {
      await messageService.sendErrorResponse(interaction,
        "Invalid server or channel ID format. Please provide valid Discord IDs."
      );
      return;
    }

    // Get source guild for simulation
    const sourceGuild = await fetchGuild(fromServerId);
    if (!sourceGuild) {
      await messageService.sendErrorResponse(interaction,
        `Could not fetch source server ${fromServerId}. Bot may not be in that server.`
      );
      return;
    }

    // Get target channel
    const targetChannel = await fetchChannel(targetChannelId);
    if (!targetChannel) {
      await messageService.sendErrorResponse(interaction,
        `Could not access target channel ${targetChannelId}. Bot may not have access.`
      );
      return;
    }

    // Check if from_channel is configured as input channel
    const channelInfo = channelService.getChannelInfo(fromChannelId);
    if (!channelInfo) {
      await messageService.sendWarningResponse(interaction,
        `Channel ${fromChannelId} is not configured as an input channel, but proceeding with test...`
      );
      // Continue execution after warning
    }

    // Create mock message
    const mockMessage = createMockMessage(
      fromServerId,
      fromChannelId,
      messageContent,
      testEmbed
    );
    mockMessage.guild = sourceGuild;

    // Debug the mock message
    debugMessage(mockMessage, "Target Test Message");

    // Validate links
    if (!containsLink(mockMessage)) {
      await messageService.sendErrorResponse(interaction,
        "Test message does not contain any links. Link detection failed."
      );
      return;
    }

    // Get role info if channel is configured
    let roleInfo = null;
    if (channelInfo) {
      // Find which server the target channel belongs to
      const targetGuild = await targetChannel.guild;
      if (targetGuild) {
        roleInfo = channelService.getRoleFromServerAndType(
          targetGuild.id,
          channelInfo.channel_type
        );
      }
    }

    // Show progress
    await messageService.sendInfoResponse(interaction, 
      formatProgressMessage(sourceGuild, targetChannel),
      { title: "🎯 Target Test Started" }
    );

    // Send test message
    const result = await sendTargetTestMessage(
      mockMessage,
      targetChannel,
      sourceGuild,
      roleInfo
    );

    // Update with results
    const resultMessage = formatTargetTestResults(result, sourceGuild, targetChannel, testEmbed);
    
    if (result.success) {
      await messageService.sendSuccessResponse(interaction, resultMessage, {
        title: "🎯 Target Test Complete"
      });
    } else {
      await messageService.sendErrorResponse(interaction, resultMessage, {
        title: "🎯 Target Test Failed"
      });
    }

  } catch (error) {
    console.error("Error in target-test command:", error);
    await messageService.sendErrorResponse(interaction,
      "Target test failed. Check console for details."
    );
  }
}

function createMockMessage(fromServerId, fromChannelId, content, isEmbed) {
  const baseMessage = {
    id: "target-test-" + Date.now(),
    attachments: new Map(),
    guildId: fromServerId,
    guild: null,
    author: {
      username: "TargetTestUser",
      displayAvatarURL: () => DEFAULT_AVATAR,
    },
    channel: { 
      id: fromChannelId,
      name: "test-channel" 
    },
    createdAt: new Date(),
  };

  if (isEmbed) {
    return {
      ...baseMessage,
      content: "Target test message with embed",
      embeds: [{
        title: "Target Test Embed",
        description: "This embed contains a test link: https://example.com/target-test",
        url: "https://example.com/target-test",
        color: EMBED_COLORS.default,
        timestamp: new Date().toISOString(),
        author: {
          name: "Target Test Author",
          url: "https://example.com/author",
        },
        footer: {
          text: "Target Test Footer",
        },
      }],
    };
  }

  return {
    ...baseMessage,
    content,
    embeds: [],
  };
}

async function fetchGuild(serverId) {
  try {
    return await client.guilds.fetch(serverId);
  } catch (error) {
    console.error(`Failed to fetch guild ${serverId}:`, error.message);
    return null;
  }
}

async function fetchChannel(channelId) {
  try {
    return await client.channels.fetch(channelId);
  } catch (error) {
    console.error(`Failed to fetch channel ${channelId}:`, error.message);
    return null;
  }
}

async function sendTargetTestMessage(mockMessage, targetChannel, sourceGuild, roleInfo) {
  try {
    // Prepare message content
    let baseContent = `**Target Test from ${sourceGuild.name}:**`;
    
    // Add role mention if available
    if (roleInfo) {
      baseContent = `<@&${roleInfo.role_id}> ${baseContent}`;
    }

    // Add message content if present
    if (mockMessage.content && mockMessage.content.trim()) {
      baseContent += `\n${mockMessage.content}`;
    }

    // Prepare embeds
    let embeds = [];
    if (mockMessage.embeds && mockMessage.embeds.length > 0) {
      embeds = mockMessage.embeds.map(embed => ({
        ...embed,
        footer: {
          ...embed.footer,
          text: `Target Test from ${sourceGuild.name}` + 
                (embed.footer?.text ? ` • ${embed.footer.text}` : ''),
        },
      }));
    } else {
      // Create source info embed if no embeds present
      embeds.push({
        color: EMBED_COLORS.default,
        author: {
          name: `${mockMessage.author.username} in ${sourceGuild.name}`,
          icon_url: mockMessage.author.displayAvatarURL(),
        },
        timestamp: mockMessage.createdAt.toISOString(),
        footer: {
          text: `Target Test from #${mockMessage.channel.name}`,
        },
      });
    }

    // Use centralized message service to send to channel
    const sentMessage = await messageService.sendToChannel(targetChannel, {
      content: baseContent,
      embeds: embeds
    });

    console.log(`✅ Target test message sent to ${targetChannel.name} (ID: ${sentMessage.id})`);

    return { 
      success: true, 
      messageId: sentMessage.id,
      channelName: targetChannel.name,
      error: null
    };

  } catch (error) {
    console.error(`❌ Failed to send target test message:`, error.message);
    return { 
      success: false, 
      messageId: null,
      channelName: targetChannel.name,
      error: error.message
    };
  }
}

function formatProgressMessage(sourceGuild, targetChannel) {
  return `📤 **From:** ${sourceGuild.name}\n🎯 **To:** ${targetChannel.name}\n🔄 **Sending...**`;
}

function formatTargetTestResults(result, sourceGuild, targetChannel, testEmbed) {
  const testType = testEmbed ? "(Embed Test)" : "(Message Test)";
  let response = `**Results** ${testType}\n\n`;
  response += `📤 **Source:** ${sourceGuild.name} (${sourceGuild.id})\n`;
  response += `🎯 **Target:** ${targetChannel.name} (${targetChannel.id})\n`;
  response += `🔗 **Link Detection:** ✅ Passed\n\n`;

  if (result.success) {
    response += `✅ **Success!** Message sent successfully\n`;
    response += `📨 **Message ID:** ${result.messageId}`;
  } else {
    response += `❌ **Failed:** ${result.error}`;
  }

  return response;
}