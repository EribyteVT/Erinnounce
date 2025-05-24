import { SlashCommandBuilder, REST, Routes } from "discord.js";

export const commands = [
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
        .setDescription("Test message content")
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName("dry_run")
        .setDescription("If true, only simulate without sending")
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName("test_embed")
        .setDescription("If true, test with an embed")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("target-test")
    .setDescription("Send a test message to a specific output channel")
    .addStringOption((option) =>
      option
        .setName("from_server_id")
        .setDescription("Source server ID to simulate message from")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("from_channel_id")
        .setDescription("Source channel ID to simulate message from")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("target_channel_id")
        .setDescription("Target output channel ID to send test message to")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("message_content")
        .setDescription("Test message content (default includes a test link)")
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName("test_embed")
        .setDescription("If true, test with an embed instead of plain message")
        .setRequired(false)
    ),
].map((command) => command.toJSON());

export async function registerCommands(clientId, token) {
  try {
    console.log("Started refreshing application (/) commands.");

    const rest = new REST({ version: "10" }).setToken(token);

    await rest.put(Routes.applicationCommands(clientId), {
      body: commands,
    });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error registering slash commands:", error);
  }
}