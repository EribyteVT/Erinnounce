import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  AttachmentBuilder,
} from "discord.js";
import pg from "pg";

let server_channels = [];
let all_input_channels = [];
let all_roles = [];

// Configuration for retry logic
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelay: 1000, // 1 second base delay
  maxDelay: 10000, // 10 seconds max delay
};

const pgClient = new pg.Pool({
  user: process.env.user,
  host: process.env.host,
  database: process.env.database,
  password: process.env.password,
  port: process.env.port,
});

const client = new Client({
  intents: [
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("retry")
    .setDescription("Retry sending a specific message by its ID")
    .addStringOption((option) =>
      option
        .setName("message_id")
        .setDescription("The ID of the message to retry")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("test")
    .setDescription("Test message relay simulation")
    .addStringOption((option) =>
      option
        .setName("server_id")
        .setDescription("Source server ID to simulate message from")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel_id")
        .setDescription("Source channel ID to simulate message from")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("message_content")
        .setDescription(
          "Test message content (will add a test link if none provided)"
        )
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName("dry_run")
        .setDescription(
          "If true, only simulate without actually sending messages"
        )
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName("test_embed")
        .setDescription(
          "If true, test with an embed containing a link instead of text"
        )
        .setRequired(false)
    ),
].map((command) => command.toJSON());

// Utility function to sleep for a given duration
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Enhanced retry function with exponential backoff
async function retryWithBackoff(
  fn,
  operation,
  maxAttempts = RETRY_CONFIG.maxAttempts
) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) {
        console.error(
          `${operation} failed after ${maxAttempts} attempts:`,
          error
        );
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(
        RETRY_CONFIG.baseDelay * Math.pow(2, attempt - 1) +
          Math.random() * 1000,
        RETRY_CONFIG.maxDelay
      );

      console.warn(
        `${operation} failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(
          delay
        )}ms:`,
        error.message
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

// Function to download and prepare attachments for forwarding
async function prepareAttachments(message) {
  const attachments = [];

  if (message.attachments && message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      try {
        // For most use cases, we can reference the attachment URL directly
        // Discord handles the attachment forwarding automatically
        attachments.push(
          new AttachmentBuilder(attachment.url, { name: attachment.name })
        );
      } catch (error) {
        console.warn(
          `Failed to prepare attachment ${attachment.name}:`,
          error.message
        );
        // Continue with other attachments if one fails
      }
    }
  }

  return attachments;
}

// Enhanced message forwarding function
// Enhanced message forwarding function with improved embed handling
async function forwardMessageToServer(
  server,
  message,
  channelInfo,
  originalGuild
) {
  const serverId = server.server_id;
  const serverName = `Server ${serverId}`;

  try {
    const role = getRoleFromServerAndType(serverId, channelInfo.channel_type);
    if (!role) {
      throw new Error(
        `No role found for server ${serverId} and type ${channelInfo.channel_type}`
      );
    }

    const outputChannel = client.channels.cache.get(server.channel_id_output);
    if (!outputChannel) {
      throw new Error(
        `Could not find output channel ${server.channel_id_output}`
      );
    }

    // Create base content with role ping and source info
    const baseContent = `<@&${role.role_id}> **From ${originalGuild.name}:**`;

    // Prepare the forwarded message data
    const forwardData = {
      content: baseContent,
      embeds: [],
      files: await prepareAttachments(message),
    };

    // Handle original message content
    if (message.content && message.content.trim()) {
      forwardData.content += `\n${message.content}`;
    }

    // Handle embeds - create deep copies and preserve all embed data
    if (message.embeds && message.embeds.length > 0) {
      console.log(
        `📎 Processing ${message.embeds.length} embed(s) for forwarding...`
      );

      for (let i = 0; i < message.embeds.length; i++) {
        const originalEmbed = message.embeds[i];

        // Create a deep copy of the embed to avoid reference issues
        const forwardedEmbed = {
          title: originalEmbed.title || undefined,
          description: originalEmbed.description || undefined,
          url: originalEmbed.url || undefined,
          color: originalEmbed.color || undefined,
          timestamp: originalEmbed.timestamp || undefined,
          fields: originalEmbed.fields ? [...originalEmbed.fields] : undefined,
          author: originalEmbed.author
            ? {
                name: originalEmbed.author.name,
                url: originalEmbed.author.url,
                icon_url:
                  originalEmbed.author.iconURL || originalEmbed.author.icon_url,
              }
            : undefined,
          thumbnail: originalEmbed.thumbnail
            ? {
                url: originalEmbed.thumbnail.url,
              }
            : undefined,
          image: originalEmbed.image
            ? {
                url: originalEmbed.image.url,
              }
            : undefined,
          footer: originalEmbed.footer
            ? {
                text: originalEmbed.footer.text,
                icon_url:
                  originalEmbed.footer.iconURL || originalEmbed.footer.icon_url,
              }
            : undefined,
        };

        // Remove undefined properties to clean up the embed
        Object.keys(forwardedEmbed).forEach((key) => {
          if (forwardedEmbed[key] === undefined) {
            delete forwardedEmbed[key];
          }
        });

        // Add source information to the first embed's footer
        if (i === 0) {
          if (!forwardedEmbed.footer) {
            forwardedEmbed.footer = {};
          }

          const sourceInfo = `Forwarded from ${originalGuild.name}`;
          if (forwardedEmbed.footer.text) {
            forwardedEmbed.footer.text = `${sourceInfo} • ${forwardedEmbed.footer.text}`;
          } else {
            forwardedEmbed.footer.text = sourceInfo;
          }
        }

        forwardData.embeds.push(forwardedEmbed);
      }

      console.log(
        `✅ Prepared ${forwardData.embeds.length} embed(s) for forwarding`
      );
    } else {
      // If no embeds in original message, create a source info embed
      forwardData.embeds.push({
        color: 0x5865f2, // Discord's blurple color
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

    // Ensure we don't send empty messages
    if (
      !forwardData.content.trim() &&
      forwardData.embeds.length === 0 &&
      forwardData.files.length === 0
    ) {
      forwardData.content = `${baseContent} *(Message with attachments)*`;
    }

    // Log what we're about to send for debugging
    console.log(`📤 Forwarding to ${serverName}:`, {
      contentLength: forwardData.content.length,
      embedCount: forwardData.embeds.length,
      fileCount: forwardData.files.length,
      hasEmbedUrls: forwardData.embeds.some((embed) => embed.url),
    });

    // Send the forwarded message with retry logic
    const sentMessage = await retryWithBackoff(
      () => outputChannel.send(forwardData),
      `Forwarding message to ${outputChannel.name} in ${serverName}`
    );

    console.log(
      `✅ Message forwarded to ${outputChannel.name} in ${serverName} (ID: ${sentMessage.id})`
    );

    // Verify the forwarded message has embeds if expected
    if (message.embeds.length > 0 && sentMessage.embeds.length === 0) {
      console.warn(
        `⚠️ Warning: Original message had ${message.embeds.length} embeds, but forwarded message has none!`
      );
    }

    return { success: true, method: "forward", messageId: sentMessage.id };
  } catch (error) {
    console.error(
      `❌ Failed to forward message to ${serverName} after all retries:`,
      error.message
    );

    // Log additional error details for debugging
    if (error.code) {
      console.error(`   Error code: ${error.code}`);
    }
    if (error.httpStatus) {
      console.error(`   HTTP Status: ${error.httpStatus}`);
    }

    return { success: false, error: error.message, serverId };
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);

  // Register slash commands
  try {
    console.log("Started refreshing application (/) commands.");

    const rest = new REST({ version: "10" }).setToken(
      process.env.DISCORD_BOT_TOKEN
    );

    await rest.put(Routes.applicationCommands(readyClient.user.id), {
      body: commands,
    });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error registering slash commands:", error);
  }

  // Load channels with retry
  retryWithBackoff(
    () => getChannelsFromDatabase(),
    "Loading channels from database"
  )
    .then((data) => {
      server_channels = data;
      all_input_channels = getAllInputChannels();
      console.log("Channel database data loaded successfully!");
    })
    .catch((error) => {
      console.error(
        "Critical error: Failed to load channels from database after all retries:",
        error
      );
      process.exit(1); // Exit if we can't load essential data
    });

  // Load roles with retry
  retryWithBackoff(() => getRolesFromDatabase(), "Loading roles from database")
    .then((data) => {
      all_roles = data;
      console.log("Roles database data loaded successfully!");
    })
    .catch((error) => {
      console.error(
        "Critical error: Failed to load roles from database after all retries:",
        error
      );
      process.exit(1); // Exit if we can't load essential data
    });
});

// Handle slash command interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "retry") {
    await handleRetryCommand(interaction);
  } else if (interaction.commandName === "test") {
    await handleTestCommandWithDebug(interaction);
  }
});

async function handleTestCommand(interaction) {
  const serverId = interaction.options.getString("server_id");
  const channelId = interaction.options.getString("channel_id");
  const messageContent =
    interaction.options.getString("message_content") ||
    "Test message with link: https://example.com";
  const dryRun = interaction.options.getBoolean("dry_run") ?? true; // Default to dry run
  const testEmbed = interaction.options.getBoolean("test_embed") ?? false;

  await interaction.deferReply({ ephemeral: true });

  try {
    // Validate server and channel IDs format
    if (!/^\d{17,19}$/.test(serverId) || !/^\d{17,19}$/.test(channelId)) {
      await interaction.editReply({
        content:
          "❌ Invalid server or channel ID format. Please provide valid Discord IDs.",
      });
      return;
    }

    // Check if the channel is configured as an input channel
    const channelInfo = getChannelInfo(channelId);
    if (!channelInfo) {
      await interaction.editReply({
        content: `❌ Channel ${channelId} is not configured as an input channel.`,
      });
      return;
    }

    // Check if the server matches the channel's configured server
    if (channelInfo.server_id !== serverId) {
      await interaction.editReply({
        content: `❌ Channel ${channelId} belongs to server ${channelInfo.server_id}, not ${serverId}.`,
      });
      return;
    }

    // Create mock message object for testing
    let mockMessage;
    if (testEmbed) {
      // Create a message with an embed containing a link
      mockMessage = {
        content: "Test message with embed",
        embeds: [
          {
            title: "Test Embed",
            description: "This embed contains a link: https://example.com",
            url: "https://example.com",
            color: 0x0099ff,
          },
        ],
        attachments: new Map(),
        guildId: serverId,
        guild: null, // Will be set later
        author: {
          username: "TestUser",
          displayAvatarURL: () =>
            "https://cdn.discordapp.com/embed/avatars/0.png",
          defaultAvatarURL: "https://cdn.discordapp.com/embed/avatars/0.png",
        },
        channel: { name: "test-channel" },
        createdAt: new Date(),
      };
    } else {
      // Create a regular message
      mockMessage = {
        content: messageContent,
        embeds: [],
        attachments: new Map(),
        guildId: serverId,
        guild: null, // Will be set later
        author: {
          username: "TestUser",
          displayAvatarURL: () =>
            "https://cdn.discordapp.com/embed/avatars/0.png",
          defaultAvatarURL: "https://cdn.discordapp.com/embed/avatars/0.png",
        },
        channel: { name: "test-channel" },
        createdAt: new Date(),
      };
    }

    // Check if message contains a link
    if (!containsLink(mockMessage)) {
      const messageType = testEmbed ? "Test embed" : "Test message";
      const messageDisplay = testEmbed
        ? `embed with title "${mockMessage.embeds[0].title}" and description "${mockMessage.embeds[0].description}"`
        : `"${messageContent}"`;

      await interaction.editReply({
        content: `❌ ${messageType} does not contain any links. Current content: ${messageDisplay}`,
      });
      return;
    }

    // Get target servers
    const targetServers = getAllServersWithout(
      serverId,
      channelInfo.channel_type
    );

    if (targetServers.length === 0) {
      await interaction.editReply({
        content: `❌ No target servers found for channel type "${channelInfo.channel_type}" (excluding source server ${serverId}).`,
      });
      return;
    }

    // Get source guild information (for simulation)
    let sourceGuild;
    try {
      sourceGuild = await client.guilds.fetch(serverId);
      mockMessage.guild = sourceGuild; // Set the guild in mock message
    } catch (error) {
      await interaction.editReply({
        content: `❌ Could not fetch source server ${serverId}. Make sure the bot is in that server.`,
      });
      return;
    }

    const mode = dryRun ? "🔍 **DRY RUN**" : "🧪 **LIVE TEST**";
    const testType = testEmbed ? "(Embed Test)" : "(Message Test)";
    let response = `${mode} ${testType} - Message Forward Simulation\n\n`;
    response += `📤 **Source:** ${sourceGuild.name} (${serverId})\n`;
    response += `📝 **Channel:** <#${channelId}> (${channelInfo.channel_type})\n`;

    if (testEmbed) {
      response += `📎 **Embed:** "${mockMessage.embeds[0].title}" - ${mockMessage.embeds[0].description}\n`;
    } else {
      response += `💬 **Message:** "${messageContent}"\n`;
    }

    response += `🎯 **Target Servers:** ${targetServers.length}\n\n`;

    if (dryRun) {
      // Dry run - just show what would happen
      response += `**📋 Target Server Details:**\n`;

      for (const server of targetServers) {
        const role = getRoleFromServerAndType(
          server.server_id,
          channelInfo.channel_type
        );
        let serverInfo = `• Server ${server.server_id}`;

        try {
          const targetGuild = await client.guilds.fetch(server.server_id);
          serverInfo = `• ${targetGuild.name} (${server.server_id})`;
        } catch (error) {
          serverInfo += ` ⚠️ (Bot not in server)`;
        }

        serverInfo += `\n  └─ Channel: <#${server.channel_id_output}>`;
        serverInfo += `\n  └─ Role: ${
          role ? `<@&${role.role_id}>` : "❌ No role found"
        }`;

        response += `${serverInfo}\n`;
      }

      response += `\n💡 Use \`dry_run: false\` to actually forward test messages.`;
      response += `\n🔗 Use \`test_embed: true\` to test with embed links.`;
    } else {
      // Live test - actually forward messages
      response += `🚀 **Forwarding test messages...**\n`;

      await interaction.editReply({ content: response });

      // Track results
      const results = {
        total: targetServers.length,
        successful: 0,
        failed: 0,
        forwardSent: 0,
        failedServers: [],
      };

      // Process all servers
      const sendPromises = targetServers.map((server) =>
        forwardMessageToServer(server, mockMessage, channelInfo, sourceGuild)
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
            return {
              success: false,
              error: error.message,
              serverId: server.server_id,
            };
          })
      );

      // Wait for all sends to complete
      await Promise.all(sendPromises);

      // Update with results
      response += `\n✅ **Test Complete**\n`;
      response += `📊 **Summary:** ${results.successful}/${results.total} successful\n`;
      response += `• Forwarded: ${results.forwardSent} | Failed: ${results.failed}`;

      if (results.failed > 0) {
        response += `\n❌ **Failed Servers:** ${results.failedServers
          .map((f) => f.serverId)
          .join(", ")}`;
      }
    }

    await interaction.editReply({ content: response });
  } catch (error) {
    console.error("Error in test command:", error);
    await interaction.editReply({
      content:
        "❌ An error occurred during the test. Please check the logs for details.",
    });
  }
}

async function handleRetryCommand(interaction) {
  const messageId = interaction.options.getString("message_id");

  await interaction.deferReply({ ephemeral: true });

  try {
    // Validate message ID format (Discord snowflake)
    if (!/^\d{17,19}$/.test(messageId)) {
      await interaction.editReply({
        content:
          "❌ Invalid message ID format. Please provide a valid Discord message ID.",
      });
      return;
    }

    // Try to fetch the message from the current channel first
    let targetMessage = null;
    let targetChannel = null;

    try {
      targetMessage = await interaction.channel.messages.fetch(messageId);
      targetChannel = interaction.channel;
    } catch (error) {
      // If not found in current channel, search through all input channels
      console.log(
        "Message not found in current channel, searching input channels..."
      );

      for (const channelId of all_input_channels) {
        try {
          const channel = await client.channels.fetch(channelId);
          if (channel) {
            targetMessage = await channel.messages.fetch(messageId);
            targetChannel = channel;
            break;
          }
        } catch (searchError) {
          // Continue searching in other channels
          continue;
        }
      }
    }

    if (!targetMessage) {
      await interaction.editReply({
        content:
          "❌ Message not found. Make sure the message ID is correct and the message exists in an input channel.",
      });
      return;
    }

    // Check if the message is from an input channel
    if (!all_input_channels.includes(targetChannel.id)) {
      await interaction.editReply({
        content:
          "❌ This message is not from a configured input channel and cannot be retried.",
      });
      return;
    }

    // Check if the message contains a link
    if (!containsLink(targetMessage)) {
      await interaction.editReply({
        content:
          "❌ This message does not contain any links and will not be relayed.",
      });
      return;
    }

    await interaction.editReply({
      content: "🔄 Starting message retry...",
    });

    // Get channel info and relay the message
    const channel_info = getChannelInfo(targetChannel.id);
    if (!channel_info) {
      await interaction.editReply({
        content: "❌ Could not find channel configuration for this message.",
      });
      return;
    }

    const server = targetMessage.guildId;
    const allwithout = getAllServersWithout(server, channel_info.channel_type);

    if (allwithout.length === 0) {
      await interaction.editReply({
        content: "❌ No target servers found for message relay.",
      });
      return;
    }

    console.log(
      `📤 Retrying message forward to ${allwithout.length} servers...`
    );

    // Track results
    const results = {
      total: allwithout.length,
      successful: 0,
      failed: 0,
      forwardSent: 0,
      failedServers: [],
    };

    // Process all servers concurrently
    const sendPromises = allwithout.map((server) =>
      forwardMessageToServer(
        server,
        targetMessage,
        channel_info,
        targetMessage.guild
      )
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
          return {
            success: false,
            error: error.message,
            serverId: server.server_id,
          };
        })
    );

    // Wait for all sends to complete
    await Promise.all(sendPromises);

    // Update the interaction with results
    let resultMessage = `✅ **Retry Complete**\n`;
    resultMessage += `📊 **Summary:** ${results.successful}/${results.total} successful\n`;
    resultMessage += `• Forwarded: ${results.forwardSent} | Failed: ${results.failed}`;

    if (results.failed > 0) {
      resultMessage += `\n❌ **Failed Servers:** ${results.failedServers
        .map((f) => f.serverId)
        .join(", ")}`;
    }

    await interaction.editReply({
      content: resultMessage,
    });

    // Log summary
    console.log(
      `📊 Retry Summary: ${results.successful}/${results.total} successful`
    );
    if (results.failed > 0) {
      console.log(
        `   • Failed servers: ${results.failedServers
          .map((f) => f.serverId)
          .join(", ")}`
      );
    }
  } catch (error) {
    console.error("Error in retry command:", error);
    await interaction.editReply({
      content:
        "❌ An error occurred while retrying the message. Please check the logs for details.",
    });
  }
}

async function getChannelsFromDatabase() {
  try {
    await pgClient.connect();
    const result = await pgClient.query("SELECT * FROM alerts.channels");
    return result.rows;
  } catch (error) {
    console.error("Database connection error:", error);
    throw error;
  }
}

async function getRolesFromDatabase() {
  try {
    await pgClient.connect();
    const result = await pgClient.query("SELECT * FROM alerts.roles");
    return result.rows;
  } catch (error) {
    console.error("Database connection error:", error);
    throw error;
  }
}

function getAllServersWithout(serverId, channelType) {
  return server_channels.filter((server) => {
    return server.server_id != serverId && server.channel_type == channelType;
  });
}

function getAllInputChannels() {
  return server_channels.map((server) => {
    return server.channel_id_input;
  });
}

function getChannelInfo(channelId) {
  return server_channels.filter((server) => {
    return server.channel_id_input == channelId;
  })[0];
}

function getRoleFromServerAndType(serverId, type) {
  let all_roles_in_server = all_roles.filter((role) => {
    return role.server_id == serverId;
  });

  let correct_type_role = all_roles_in_server.filter((role) => {
    return role.role_type == type;
  })[0];

  return correct_type_role;
}

function containsLink(message) {
  // Enhanced regular expression to match URLs
  const urlRegex =
    /(https?:\/\/[^\s<>]+|www\.[^\s<>]+|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*\.[a-z]{2,}(?:\/[^\s<>]*)?)/gi;

  // Check message content first
  if (typeof message === "string") {
    const hasLink = urlRegex.test(message);
    console.log(`🔍 String link check: ${hasLink}`);
    return hasLink;
  }

  let linkFound = false;
  const linkSources = [];

  // For Discord message objects, check content
  if (message.content && urlRegex.test(message.content)) {
    linkFound = true;
    linkSources.push("message content");
  }

  // Check embeds for links with detailed logging
  if (message.embeds && message.embeds.length > 0) {
    console.log(`🔍 Checking ${message.embeds.length} embed(s) for links...`);

    for (let i = 0; i < message.embeds.length; i++) {
      const embed = message.embeds[i];
      console.log(`   📎 Checking embed ${i + 1}:`, {
        hasUrl: !!embed.url,
        hasTitle: !!embed.title,
        hasDescription: !!embed.description,
        hasFields: embed.fields ? embed.fields.length : 0,
        hasFooter: !!embed.footer,
        hasAuthor: !!embed.author,
      });

      // Check embed URL
      if (embed.url && urlRegex.test(embed.url)) {
        linkFound = true;
        linkSources.push(`embed ${i + 1} URL`);
        console.log(`   ✅ Found link in embed ${i + 1} URL: ${embed.url}`);
      }

      // Check embed title
      if (embed.title && urlRegex.test(embed.title)) {
        linkFound = true;
        linkSources.push(`embed ${i + 1} title`);
        console.log(`   ✅ Found link in embed ${i + 1} title: ${embed.title}`);
      }

      // Check embed description
      if (embed.description && urlRegex.test(embed.description)) {
        linkFound = true;
        linkSources.push(`embed ${i + 1} description`);
        console.log(`   ✅ Found link in embed ${i + 1} description`);
      }

      // Check embed fields
      if (embed.fields && embed.fields.length > 0) {
        for (let j = 0; j < embed.fields.length; j++) {
          const field = embed.fields[j];
          if (
            (field.name && urlRegex.test(field.name)) ||
            (field.value && urlRegex.test(field.value))
          ) {
            linkFound = true;
            linkSources.push(`embed ${i + 1} field ${j + 1}`);
            console.log(`   ✅ Found link in embed ${i + 1} field ${j + 1}`);
          }
        }
      }

      // Check embed footer
      if (
        embed.footer &&
        embed.footer.text &&
        urlRegex.test(embed.footer.text)
      ) {
        linkFound = true;
        linkSources.push(`embed ${i + 1} footer`);
        console.log(`   ✅ Found link in embed ${i + 1} footer`);
      }

      // Check embed author
      if (embed.author) {
        if (embed.author.name && urlRegex.test(embed.author.name)) {
          linkFound = true;
          linkSources.push(`embed ${i + 1} author name`);
          console.log(`   ✅ Found link in embed ${i + 1} author name`);
        }
        if (embed.author.url && urlRegex.test(embed.author.url)) {
          linkFound = true;
          linkSources.push(`embed ${i + 1} author URL`);
          console.log(`   ✅ Found link in embed ${i + 1} author URL`);
        }
      }
    }
  }

  // Check for attachment URLs (these might contain links)
  if (message.attachments && message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      if (attachment.url && urlRegex.test(attachment.url)) {
        linkFound = true;
        linkSources.push("attachment URL");
        console.log(`   ✅ Found link in attachment: ${attachment.name}`);
      }
    }
  }

  console.log(`🔍 Link detection result: ${linkFound}`, {
    sources: linkSources,
    messageId: message.id || "unknown",
    hasContent: !!message.content,
    embedCount: message.embeds ? message.embeds.length : 0,
    attachmentCount: message.attachments ? message.attachments.size : 0,
  });

  return linkFound;
}

client.on("messageCreate", async (message) => {
  const channel = message.channelId;

  if (!all_input_channels.includes(channel)) {
    return;
  }

  if (!containsLink(message)) {
    console.log("Message does not contain a link, skipping...");
    return;
  }

  const channel_info = getChannelInfo(channel);
  const server = message.guildId;
  const allwithout = getAllServersWithout(server, channel_info.channel_type);

  if (allwithout.length === 0) {
    console.log("No target servers found for message relay");
    return;
  }

  console.log(`📤 Forwarding message to ${allwithout.length} servers...`);

  // Track results
  const results = {
    total: allwithout.length,
    successful: 0,
    failed: 0,
    forwardSent: 0,
    failedServers: [],
  };

  // Process all servers concurrently but with individual error handling
  const sendPromises = allwithout.map((server) =>
    forwardMessageToServer(server, message, channel_info, message.guild)
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
        // This shouldn't happen due to our error handling, but just in case
        console.error("Unexpected error in forwardMessageToServer:", error);
        results.failed++;
        results.failedServers.push({
          serverId: server.server_id,
          error: error.message,
        });
        return {
          success: false,
          error: error.message,
          serverId: server.server_id,
        };
      })
  );

  // Wait for all sends to complete
  try {
    await Promise.all(sendPromises);

    // Log summary
    console.log(
      `Forward Summary: ${results.successful}/${results.total} successful`
    );
    console.log(
      `   • Forwarded: ${results.forwardSent}, Failed: ${results.failed}`
    );

    if (results.failed > 0) {
      console.log(
        `   • Failed servers: ${results.failedServers
          .map((f) => f.serverId)
          .join(", ")}`
      );
    }
  } catch (error) {
    console.error("Unexpected error during message forwarding:", error);
  }
});

// Handle process termination gracefully
process.on("SIGINT", async () => {
  console.log("Received SIGINT, shutting down gracefully...");
  try {
    await pgClient.end();
    await client.destroy();
  } catch (error) {
    console.error("Error during shutdown:", error);
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Received SIGTERM, shutting down gracefully...");
  try {
    await pgClient.end();
    await client.destroy();
  } catch (error) {
    console.error("Error during shutdown:", error);
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Debug function to analyze message structure and embeds
function debugMessage(message, label = "Message Debug") {
  console.log(`\n🐛 ${label} - Message Analysis:`);
  console.log(`   Message ID: ${message.id}`);
  console.log(`   Author: ${message.author.username}`);
  console.log(
    `   Content Length: ${message.content ? message.content.length : 0}`
  );
  console.log(`   Has Content: ${!!message.content}`);
  console.log(`   Embed Count: ${message.embeds ? message.embeds.length : 0}`);
  console.log(
    `   Attachment Count: ${message.attachments ? message.attachments.size : 0}`
  );

  if (message.content) {
    console.log(
      `   Content Preview: "${message.content.substring(0, 100)}${
        message.content.length > 100 ? "..." : ""
      }"`
    );
  }

  if (message.embeds && message.embeds.length > 0) {
    console.log(`\n   📎 Embed Details:`);
    message.embeds.forEach((embed, index) => {
      console.log(`     Embed ${index + 1}:`);
      console.log(`       Title: ${embed.title ? `"${embed.title}"` : "None"}`);
      console.log(
        `       Description: ${
          embed.description
            ? `"${embed.description.substring(0, 50)}..."`
            : "None"
        }`
      );
      console.log(`       URL: ${embed.url || "None"}`);
      console.log(`       Color: ${embed.color || "None"}`);
      console.log(`       Timestamp: ${embed.timestamp || "None"}`);
      console.log(`       Fields: ${embed.fields ? embed.fields.length : 0}`);
      console.log(
        `       Author: ${embed.author ? embed.author.name : "None"}`
      );
      console.log(
        `       Thumbnail: ${embed.thumbnail ? embed.thumbnail.url : "None"}`
      );
      console.log(`       Image: ${embed.image ? embed.image.url : "None"}`);
      console.log(
        `       Footer: ${embed.footer ? embed.footer.text : "None"}`
      );

      // Check if this embed has any links
      const embedHasLinks = containsLink({ embeds: [embed] });
      console.log(`       Contains Links: ${embedHasLinks}`);
    });
  }

  if (message.attachments && message.attachments.size > 0) {
    console.log(`\n   📎 Attachment Details:`);
    message.attachments.forEach((attachment, index) => {
      console.log(
        `     Attachment ${index + 1}: ${attachment.name} (${attachment.url})`
      );
    });
  }

  console.log(`\n   🔗 Overall Link Detection: ${containsLink(message)}\n`);
}

// Enhanced test command handler with better debugging
async function handleTestCommandWithDebug(interaction) {
  const serverId = interaction.options.getString("server_id");
  const channelId = interaction.options.getString("channel_id");
  const messageContent =
    interaction.options.getString("message_content") ||
    "Test message with link: https://example.com";
  const dryRun = interaction.options.getBoolean("dry_run") ?? true;
  const testEmbed = interaction.options.getBoolean("test_embed") ?? false;

  await interaction.deferReply({ ephemeral: true });

  try {
    // Validate server and channel IDs format
    if (!/^\d{17,19}$/.test(serverId) || !/^\d{17,19}$/.test(channelId)) {
      await interaction.editReply({
        content:
          "❌ Invalid server or channel ID format. Please provide valid Discord IDs.",
      });
      return;
    }

    // Check if the channel is configured as an input channel
    const channelInfo = getChannelInfo(channelId);
    if (!channelInfo) {
      await interaction.editReply({
        content: `❌ Channel ${channelId} is not configured as an input channel.`,
      });
      return;
    }

    // Create mock message object for testing
    let mockMessage;
    if (testEmbed) {
      mockMessage = {
        id: "test-message-" + Date.now(),
        content: "Test message with embed",
        embeds: [
          {
            title: "Test Embed",
            description: "This embed contains a link: https://example.com",
            url: "https://example.com",
            color: 0x0099ff,
            timestamp: new Date().toISOString(),
            author: {
              name: "Test Author",
              url: "https://example.com/author",
            },
            footer: {
              text: "Test Footer",
            },
          },
        ],
        attachments: new Map(),
        guildId: serverId,
        guild: null,
        author: {
          username: "TestUser",
          displayAvatarURL: () =>
            "https://cdn.discordapp.com/embed/avatars/0.png",
        },
        channel: { name: "test-channel" },
        createdAt: new Date(),
      };
    } else {
      mockMessage = {
        id: "test-message-" + Date.now(),
        content: messageContent,
        embeds: [],
        attachments: new Map(),
        guildId: serverId,
        guild: null,
        author: {
          username: "TestUser",
          displayAvatarURL: () =>
            "https://cdn.discordapp.com/embed/avatars/0.png",
        },
        channel: { name: "test-channel" },
        createdAt: new Date(),
      };
    }

    // Debug the mock message
    debugMessage(mockMessage, "Mock Test Message");

    // Check if message contains a link
    if (!containsLink(mockMessage)) {
      const messageType = testEmbed ? "Test embed" : "Test message";
      await interaction.editReply({
        content: `❌ ${messageType} does not contain any links according to link detection.`,
      });
      return;
    }

    // Get target servers
    const targetServers = getAllServersWithout(
      serverId,
      channelInfo.channel_type
    );

    if (targetServers.length === 0) {
      await interaction.editReply({
        content: `❌ No target servers found for channel type "${channelInfo.channel_type}".`,
      });
      return;
    }

    // Get source guild information
    let sourceGuild;
    try {
      sourceGuild = await client.guilds.fetch(serverId);
      mockMessage.guild = sourceGuild;
    } catch (error) {
      await interaction.editReply({
        content: `❌ Could not fetch source server ${serverId}. Bot may not be in that server.`,
      });
      return;
    }

    let response = `🧪 **Test Results** ${
      testEmbed ? "(Embed Test)" : "(Message Test)"
    }\n\n`;
    response += `📤 **Source:** ${sourceGuild.name} (${serverId})\n`;
    response += `📝 **Channel:** <#${channelId}> (${channelInfo.channel_type})\n`;
    response += `🎯 **Target Servers:** ${targetServers.length}\n`;
    response += `🔗 **Link Detection:** ✅ Passed\n\n`;

    if (dryRun) {
      response += `🔍 **DRY RUN** - No messages will be sent\n`;
      response += `📋 **Mock Message Analysis:**\n`;
      response += `• Content: ${
        mockMessage.content
          ? `"${mockMessage.content.substring(0, 50)}..."`
          : "None"
      }\n`;
      response += `• Embeds: ${mockMessage.embeds.length}\n`;
      if (mockMessage.embeds.length > 0) {
        response += `• Embed URLs: ${
          mockMessage.embeds.filter((e) => e.url).length
        }\n`;
      }
      response += `\n💡 Use \`dry_run: false\` to actually send test messages.`;
    } else {
      response += `🚀 **LIVE TEST** - Sending messages...\n`;
      await interaction.editReply({ content: response });

      // Process forwarding with enhanced debugging
      const results = {
        total: targetServers.length,
        successful: 0,
        failed: 0,
        failedServers: [],
      };

      for (const server of targetServers) {
        console.log(`\n🎯 Testing forward to server ${server.server_id}...`);

        const result = await forwardMessageToServer(
          server,
          mockMessage,
          channelInfo,
          sourceGuild
        );

        if (result.success) {
          results.successful++;
          console.log(
            `✅ Test forward successful to server ${server.server_id}`
          );
        } else {
          results.failed++;
          results.failedServers.push(server.server_id);
          console.log(
            `❌ Test forward failed to server ${server.server_id}: ${result.error}`
          );
        }
      }

      response += `\n✅ **Test Complete:** ${results.successful}/${results.total} successful`;
      if (results.failed > 0) {
        response += `\n❌ **Failed:** ${results.failedServers.join(", ")}`;
      }
    }

    await interaction.editReply({ content: response });
  } catch (error) {
    console.error("Error in test command:", error);
    await interaction.editReply({
      content: "❌ Test failed. Check console for details.",
    });
  }
}

client.login(process.env.DISCORD_BOT_TOKEN);
