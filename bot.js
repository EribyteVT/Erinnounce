import { Client, GatewayIntentBits, Events } from "discord.js";
import pg from "pg";

let server_channels = [];
let all_input_channels = [];
let all_roles = [];
let webhooks_cache = new Map(); // Cache webhooks to avoid creating duplicates

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

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);

  getChannelsFromDatabase()
    .then((data) => {
      server_channels = data;
      all_input_channels = getAllInputChannels();

      console.log("Database data loaded successfully!");
    })
    .catch((error) => {
      console.error("Error loading database data:", error);
    });

  getRolesFromDatabase()
    .then((data) => {
      all_roles = data;

      console.log("Database data loaded successfully!");
    })
    .catch((error) => {
      console.error("Error loading database data:", error);
    });
});

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

// Create or get a webhook for a channel
async function getOrCreateWebhook(channel) {
  const cacheKey = channel.id;

  if (webhooks_cache.has(cacheKey)) {
    return webhooks_cache.get(cacheKey);
  }

  try {
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

    webhooks_cache.set(cacheKey, webhook);
    return webhook;
  } catch (error) {
    console.error(
      `Error getting/creating webhook for channel ${channel.name}:`,
      error
    );
    return null;
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

  // Get the original author's avatar URL (with fallback to default avatar)
  const avatarURL = message.guild.iconURL() || message.author.defaultAvatarURL;

  // Create a username that includes the origin server name
  const customUsername = `From ${message.guild.name}`;

  for (const server of allwithout) {
    console.log(`sending to ${server.server_id}`);

    const role = getRoleFromServerAndType(
      server.server_id,
      channel_info.channel_type
    );
    const outputChannel = client.channels.cache.get(server.channel_id_output);

    if (!outputChannel) {
      console.error(
        `Could not find output channel ${server.channel_id_output}`
      );
      continue;
    }

    try {
      const webhook = await getOrCreateWebhook(outputChannel);

      if (webhook) {
        // Send message using webhook with custom avatar and username
        await webhook.send({
          content: `<@&${role.role_id}> ${message.content}`,
          username: customUsername,
          avatarURL: avatarURL,
        });
        console.log(`Message sent via webhook to ${outputChannel.name}`);
      } else {
        // Fallback to regular send if webhook creation fails
        await outputChannel.send(`<@&${role.role_id}> ${message.content}`);
        console.log(`Message sent (fallback) to ${outputChannel.name}`);
      }
    } catch (error) {
      console.error(`Error sending message to ${outputChannel.name}:`, error);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
