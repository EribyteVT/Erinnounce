import { Client, GatewayIntentBits, Events } from "discord.js";
import pg from "pg";

let server_channels = [];
let all_input_channels = [];

let all_roles = [];

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
    // Connect to the database
    await pgClient.connect();

    // Example query - modify this to match your database schema
    const result = await pgClient.query("SELECT * FROM alerts.channels");

    // Return the rows from the query
    return result.rows;
  } catch (error) {
    console.error("Database connection error:", error);
    throw error;
  }
}

async function getRolesFromDatabase() {
  try {
    // Connect to the database
    await pgClient.connect();

    // Example query - modify this to match your database schema
    const result = await pgClient.query("SELECT * FROM alerts.roles");

    // Return the rows from the query
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

client.on("messageCreate", (message) => {
  const channel = message.channelId;

  console.log(all_input_channels);

  if (!all_input_channels.includes(channel)) {
    console.log("not in");
    return;
  }

  console.log("in a good channel");

  const channel_info = getChannelInfo(channel);

  const server = message.guildId;

  const allwithout = getAllServersWithout(server, channel_info.channel_type);

  console.log(allwithout);

  allwithout.forEach((server) => {
    console.log(`sending to ${server.server_id}`);
    let role = getRoleFromServerAndType(
      server.server_id,
      channel_info.channel_type
    );

    const outputChannel = client.channels.cache.get(server.channel_id_output);
    outputChannel.send(`<@&${role.role_id}> ${message.content}`);
  });
});

client.login(process.env.DISCORD_BOT_TOKEN);
