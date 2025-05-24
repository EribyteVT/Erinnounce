import { client } from "../index.js";
import { channelService } from "../services/channelService.js";
import { messageService } from "../services/messageService.js";
import { containsLink } from "../utils/linkDetection.js";
import { debugMessage } from "../utils/messageDebug.js";
import { DEFAULT_AVATAR, EMBED_COLORS } from "../config/constants.js";

export async function handleTestCommand(interaction) {
  const serverId = interaction.options.getString("server_id");
  const channelId = interaction.options.getString("channel_id");
  const messageContent = interaction.options.getString("message_content") || 
    "Test message with link: https://example.com";
  const dryRun = interaction.options.getBoolean("dry_run") ?? true;
  const testEmbed = interaction.options.getBoolean("test_embed") ?? false;

  await interaction.deferReply({ ephemeral: true });

  try {
    // Validate IDs
    if (!/^\d{17,19}$/.test(serverId) || !/^\d{17,19}$/.test(channelId)) {
      await interaction.editReply({
        content: "❌ Invalid server or channel ID format.",
      });
      return;
    }

    // Check channel configuration
    const channelInfo = channelService.getChannelInfo(channelId);
    if (!channelInfo) {
      await interaction.editReply({
        content: `❌ Channel ${channelId} is not configured as an input channel.`,
      });
      return;
    }

    // Create mock message
    const mockMessage = createMockMessage(
      serverId,
      messageContent,
      testEmbed
    );

    // Debug the mock message
    debugMessage(mockMessage, "Mock Test Message");

    // Validate links
    if (!containsLink(mockMessage)) {
      await interaction.editReply({
        content: `❌ Test message does not contain any links.`,
      });
      return;
    }

    // Get source guild
    const sourceGuild = await fetchGuild(serverId);
    if (!sourceGuild) {
      await interaction.editReply({
        content: `❌ Could not fetch source server ${serverId}.`,
      });
      return;
    }
    mockMessage.guild = sourceGuild;

    // Execute test
    const response = await executeTest(
      mockMessage,
      channelInfo,
      sourceGuild,
      dryRun,
      testEmbed
    );

    await interaction.editReply({ content: response });
  } catch (error) {
    console.error("Error in test command:", error);
    await interaction.editReply({
      content: "❌ Test failed. Check console for details.",
    });
  }
}

function createMockMessage(serverId, content, isEmbed) {
  const baseMessage = {
    id: "test-message-" + Date.now(),
    attachments: new Map(),
    guildId: serverId,
    guild: null,
    author: {
      username: "TestUser",
      displayAvatarURL: () => DEFAULT_AVATAR,
    },
    channel: { name: "test-channel" },
    createdAt: new Date(),
  };

  if (isEmbed) {
    return {
      ...baseMessage,
      content: "Test message with embed",
      embeds: [{
        title: "Test Embed",
        description: "This embed contains a link: https://example.com",
        url: "https://example.com",
        color: EMBED_COLORS.default,
        timestamp: new Date().toISOString(),
        author: {
          name: "Test Author",
          url: "https://example.com/author",
        },
        footer: {
          text: "Test Footer",
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
    return null;
  }
}

async function executeTest(mockMessage, channelInfo, sourceGuild, dryRun, testEmbed) {
  const targetServers = channelService.getAllServersWithout(
    sourceGuild.id,
    channelInfo.channel_type
  );

  if (targetServers.length === 0) {
    return `❌ No target servers found for channel type "${channelInfo.channel_type}".`;
  }

  let response = formatTestHeader(sourceGuild, channelInfo, targetServers, testEmbed);

  if (dryRun) {
    response += await formatDryRunDetails(targetServers, channelInfo);
  } else {
    response += await executeLiveTest(
      mockMessage,
      channelInfo,
      targetServers,
      sourceGuild
    );
  }

  return response;
}

function formatTestHeader(sourceGuild, channelInfo, targetServers, testEmbed) {
  const testType = testEmbed ? "(Embed Test)" : "(Message Test)";
  let response = `🧪 **Test Results** ${testType}\n\n`;
  response += `📤 **Source:** ${sourceGuild.name} (${sourceGuild.id})\n`;
  response += `📝 **Channel:** <#${channelInfo.channel_id_input}> (${channelInfo.channel_type})\n`;
  response += `🎯 **Target Servers:** ${targetServers.length}\n`;
  response += `🔗 **Link Detection:** ✅ Passed\n\n`;
  return response;
}

async function formatDryRunDetails(targetServers, channelInfo) {
  let response = `🔍 **DRY RUN** - No messages will be sent\n`;
  response += `📋 **Target Server Details:**\n`;

  for (const server of targetServers) {
    const role = channelService.getRoleFromServerAndType(
      server.server_id,
      channelInfo.channel_type
    );
    
    let serverInfo = await getServerInfo(server.server_id);
    serverInfo += `\n  └─ Channel: <#${server.channel_id_output}>`;
    serverInfo += `\n  └─ Role: ${role ? `<@&${role.role_id}>` : "❌ No role found"}`;
    
    response += `${serverInfo}\n`;
  }

  response += `\n💡 Use \`dry_run: false\` to actually send test messages.`;
  return response;
}

async function getServerInfo(serverId) {
  try {
    const guild = await client.guilds.fetch(serverId);
    return `• ${guild.name} (${serverId})`;
  } catch (error) {
    return `• Server ${serverId} ⚠️ (Bot not in server)`;
  }
}

async function executeLiveTest(mockMessage, channelInfo, targetServers, sourceGuild) {
  let response = `🚀 **LIVE TEST** - Sending messages...\n`;
  
  const results = await messageService.forwardToServers(
    mockMessage,
    channelInfo,
    targetServers,
    sourceGuild
  );

  response += `\n✅ **Test Complete:** ${results.successful}/${results.total} successful`;
  if (results.failed > 0) {
    response += `\n❌ **Failed:** ${results.failedServers.map(f => f.serverId).join(", ")}`;
  }

  return response;
}