import { retryWithBackoff } from "../utils/retry.js";
import { databaseService } from "../services/databaseService.js";
import { channelService } from "../services/channelService.js";
import { roleService } from "../services/roleService.js";
import { messageService } from "../services/messageService.js";
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
    
    // Example: If you wanted to notify admins via Discord
    // await notifyAdminsOfStartupError("Failed to load channels", error);
    
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
    
    // Example: If you wanted to notify admins via Discord
    // await notifyAdminsOfStartupError("Failed to load roles", error);
    
    process.exit(1);
  }

  // Example: Send startup notification to admin channel (if configured)
  // await notifyStartupSuccess(readyClient);
}

// Example function showing how to use centralized message service for admin notifications
async function notifyAdminsOfStartupError(operation, error) {
  try {
    const adminChannelId = process.env.ADMIN_CHANNEL_ID;
    if (adminChannelId) {
      const adminChannel = await client.channels.fetch(adminChannelId);
      if (adminChannel) {
        await messageService.sendToChannel(adminChannel, {
          embeds: [{
            title: "🚨 Bot Startup Error",
            description: `Failed during: ${operation}`,
            color: 0xff0000,
            fields: [
              {
                name: "Error Message",
                value: error.message || "Unknown error"
              }
            ],
            timestamp: new Date().toISOString()
          }]
        });
      }
    }
  } catch (notificationError) {
    console.error("Failed to send admin notification:", notificationError);
  }
}

// Example function showing startup success notification
async function notifyStartupSuccess(client) {
  try {
    const adminChannelId = process.env.ADMIN_CHANNEL_ID;
    if (adminChannelId) {
      const adminChannel = await client.channels.fetch(adminChannelId);
      if (adminChannel) {
        await messageService.sendToChannel(adminChannel, {
          embeds: [{
            title: "✅ Bot Started Successfully",
            description: `${client.user.tag} is now online and ready to relay messages.`,
            color: 0x00ff00,
            fields: [
              {
                name: "Servers Connected",
                value: client.guilds.cache.size.toString(),
                inline: true
              },
              {
                name: "Channels Configured",
                value: channelService.getAllInputChannels().length.toString(),
                inline: true
              }
            ],
            timestamp: new Date().toISOString()
          }]
        });
      }
    }
  } catch (error) {
    console.error("Failed to send startup notification:", error);
  }
}