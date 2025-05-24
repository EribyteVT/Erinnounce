import { retryWithBackoff } from "../utils/retry.js";
import { databaseService } from "../services/databaseService.js";
import { channelService } from "../services/channelService.js";
import { roleService } from "../services/roleService.js";
import { registerCommands } from "../commands/index.js";

export async function handleReady(readyClient) {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);

  // Register slash commands
  await registerCommands(readyClient.user.id, process.env.DISCORD_BOT_TOKEN);

  // Load channels with retry
  try {
    const channels = await retryWithBackoff(
      () => databaseService.getChannels(),
      "Loading channels from database"
    );
    channelService.setChannels(channels);
    console.log("Channel database data loaded successfully!");
  } catch (error) {
    console.error("Critical error: Failed to load channels from database:", error);
    process.exit(1);
  }

  // Load roles with retry
  try {
    await retryWithBackoff(
      () => roleService.loadRoles(),
      "Loading roles from database"
    );
    console.log("Roles database data loaded successfully!");
  } catch (error) {
    console.error("Critical error: Failed to load roles from database:", error);
    process.exit(1);
  }
}