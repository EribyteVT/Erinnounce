import { Client, GatewayIntentBits, Events } from "discord.js";
import dotenv from "dotenv";
import { pgClient } from "./config/database.js";
import { registerCommands } from "./commands/index.js";
import { handleReady } from "./handlers/readyHandler.js";
import { handleMessageCreate } from "./handlers/messageHandler.js";
import { handleRetryCommand } from "./commands/retry.js";
import { handleTestCommand } from "./commands/test.js";
import { handleTargetTestCommand } from "./commands/targetTest.js";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

// Event handlers
client.once(Events.ClientReady, (readyClient) => handleReady(readyClient));
client.on(Events.MessageCreate, (message) => handleMessageCreate(message));

// Command handlers
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "retry":
      await handleRetryCommand(interaction);
      break;
    case "test":
      await handleTestCommand(interaction);
      break;
    case "target-test":
      await handleTargetTestCommand(interaction);
      break;
  }
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`Received ${signal}, shutting down gracefully...`);
  try {
    await pgClient.end();
    await client.destroy();
  } catch (error) {
    console.error("Error during shutdown:", error);
  }
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Error handlers
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);

export { client };