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

    // Prepare the forwarded message data
    const forwardData = {
      content: `<@&${role.role_id}> **From ${originalGuild.name}:**\n${
        message.content || ""
      }`,
      embeds: [...(message.embeds || [])],
      files: await prepareAttachments(message),
    };

    // Add source information to the message if it doesn't have embeds
    if (message.embeds.length === 0 && message.content) {
      // Create a simple embed to show the source
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
    } else if (message.embeds.length > 0) {
      // If there are embeds, add source info to the first embed
      const firstEmbed = { ...forwardData.embeds[0] };
      if (!firstEmbed.footer) {
        firstEmbed.footer = {};
      }
      firstEmbed.footer.text = `Forwarded from ${originalGuild.name} • ${
        firstEmbed.footer.text || ""
      }`.trim();
      forwardData.embeds[0] = firstEmbed;
    }

    // Remove any empty content to avoid sending empty messages
    if (!forwardData.content.trim() && forwardData.embeds.length === 0) {
      forwardData.content = `<@&${role.role_id}> **From ${originalGuild.name}:** *(Message with attachments)*`;
    }

    // Send the forwarded message with retry logic
    await retryWithBackoff(
      () => outputChannel.send(forwardData),
      `Forwarding message to ${outputChannel.name} in ${serverName}`
    );

    console.log(
      `✅ Message forwarded to ${outputChannel.name} in ${serverName}`
    );
    return { success: true, method: "forward" };
  } catch (error) {
    console.error(
      `❌ Failed to forward message to ${serverName} after all retries:`,
      error.message
    );
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
    await handleTestCommand(interaction);
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
  // Regular expression to match URLs
  const urlRegex =
    /(https?:\/\/[^\s]+|www\.[^\s]+|[^\s]+\.[a-z]{2,}(?:\/[^\s]*)?)/gi;

  // Check message content first
  if (typeof message === "string") {
    return urlRegex.test(message);
  }

  // For Discord message objects, check content
  if (message.content && urlRegex.test(message.content)) {
    return true;
  }

  // Check embeds for links
  if (message.embeds && message.embeds.length > 0) {
    for (const embed of message.embeds) {
      // Check embed URL
      if (embed.url && urlRegex.test(embed.url)) {
        return true;
      }

      // Check embed title
      if (embed.title && urlRegex.test(embed.title)) {
        return true;
      }

      // Check embed description
      if (embed.description && urlRegex.test(embed.description)) {
        return true;
      }

      // Check embed fields
      if (embed.fields && embed.fields.length > 0) {
        for (const field of embed.fields) {
          if (
            (field.name && urlRegex.test(field.name)) ||
            (field.value && urlRegex.test(field.value))
          ) {
            return true;
          }
        }
      }

      // Check embed footer
      if (
        embed.footer &&
        embed.footer.text &&
        urlRegex.test(embed.footer.text)
      ) {
        return true;
      }

      // Check embed author
      if (
        embed.author &&
        embed.author.name &&
        urlRegex.test(embed.author.name)
      ) {
        return true;
      }
    }
  }

  return false;
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

client.login(process.env.DISCORD_BOT_TOKEN);
