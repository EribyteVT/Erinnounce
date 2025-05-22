import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
} from "discord.js";
import pg from "pg";

let server_channels = [];
let all_input_channels = [];
let all_roles = [];
let webhooks_cache = new Map(); // Cache webhooks to avoid creating duplicates

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
  }
});

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
    if (!containsLink(targetMessage.content)) {
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

    console.log(`📤 Retrying message relay to ${allwithout.length} servers...`);

    // Track results
    const results = {
      total: allwithout.length,
      successful: 0,
      failed: 0,
      webhookSent: 0,
      fallbackSent: 0,
      failedServers: [],
    };

    // Process all servers concurrently
    const sendPromises = allwithout.map((server) =>
      sendMessageToServer(
        server,
        targetMessage,
        channel_info,
        targetMessage.guild
      )
        .then((result) => {
          if (result.success) {
            results.successful++;
            if (result.method === "webhook") {
              results.webhookSent++;
            } else {
              results.fallbackSent++;
            }
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
          console.error("Unexpected error in sendMessageToServer:", error);
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
    resultMessage += `• Webhook: ${results.webhookSent} | Fallback: ${results.fallbackSent} | Failed: ${results.failed}`;

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
  return urlRegex.test(message);
}

// Enhanced webhook function with retry logic
async function getOrCreateWebhook(channel) {
  const cacheKey = channel.id;

  if (webhooks_cache.has(cacheKey)) {
    return webhooks_cache.get(cacheKey);
  }

  try {
    const webhook = await retryWithBackoff(async () => {
      // Check if a webhook already exists for this channel
      const webhooks = await channel.fetchWebhooks();
      let webhook = webhooks.find((wh) => wh.name === "Erinnounce Relay");

      if (!webhook) {
        // Create a new webhook if none exists
        webhook = await channel.createWebhook({
          name: "Erinnounce Relay",
          reason:
            "Webhook for message relaying with custom avatars and usernames",
        });
        console.log(`Created new webhook for channel ${channel.name}`);
      }

      return webhook;
    }, `Getting/creating webhook for channel ${channel.name}`);

    webhooks_cache.set(cacheKey, webhook);
    return webhook;
  } catch (error) {
    console.error(
      `Failed to get/create webhook for channel ${channel.name} after all retries:`,
      error
    );
    return null;
  }
}

// Enhanced message sending function with retry logic
async function sendMessageToServer(
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

    // Get the original guild's avatar URL (with fallback to default avatar)
    const avatarURL =
      originalGuild.iconURL() || message.author.defaultAvatarURL;
    const customUsername = `From ${originalGuild.name}`;
    const messageContent = `<@&${role.role_id}> ${message.content}`;

    // Try to send via webhook first, with retry
    try {
      const webhook = await getOrCreateWebhook(outputChannel);

      if (webhook) {
        await retryWithBackoff(
          () =>
            webhook.send({
              content: messageContent,
              username: customUsername,
              avatarURL: avatarURL,
            }),
          `Sending webhook message to ${outputChannel.name} in ${serverName}`
        );

        console.log(
          `✅ Message sent via webhook to ${outputChannel.name} in ${serverName}`
        );
        return { success: true, method: "webhook" };
      }
    } catch (webhookError) {
      console.warn(
        `Webhook failed for ${serverName}, trying fallback method:`,
        webhookError.message
      );
    }

    // Fallback to regular send with retry
    await retryWithBackoff(
      () => outputChannel.send(messageContent),
      `Sending fallback message to ${outputChannel.name} in ${serverName}`
    );

    console.log(
      `✅ Message sent (fallback) to ${outputChannel.name} in ${serverName}`
    );
    return { success: true, method: "fallback" };
  } catch (error) {
    console.error(
      `❌ Failed to send message to ${serverName} after all retries:`,
      error.message
    );
    return { success: false, error: error.message, serverId };
  }
}

client.on("messageCreate", async (message) => {
  const channel = message.channelId;

  if (!all_input_channels.includes(channel)) {
    return;
  }

  if (!containsLink(message.content)) {
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

  console.log(`📤 Relaying message to ${allwithout.length} servers...`);

  // Track results
  const results = {
    total: allwithout.length,
    successful: 0,
    failed: 0,
    webhookSent: 0,
    fallbackSent: 0,
    failedServers: [],
  };

  // Process all servers concurrently but with individual error handling
  const sendPromises = allwithout.map((server) =>
    sendMessageToServer(server, message, channel_info, message.guild)
      .then((result) => {
        if (result.success) {
          results.successful++;
          if (result.method === "webhook") {
            results.webhookSent++;
          } else {
            results.fallbackSent++;
          }
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
        console.error("Unexpected error in sendMessageToServer:", error);
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
      `Relay Summary: ${results.successful}/${results.total} successful`
    );
    console.log(
      `   • Webhook: ${results.webhookSent}, Fallback: ${results.fallbackSent}, Failed: ${results.failed}`
    );

    if (results.failed > 0) {
      console.log(
        `   • Failed servers: ${results.failedServers
          .map((f) => f.serverId)
          .join(", ")}`
      );
    }
  } catch (error) {
    console.error("Unexpected error during message relay:", error);
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
