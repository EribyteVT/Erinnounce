import { channelService } from "../services/channelService.js";
import { messageService } from "../services/messageService.js";
import { containsLink } from "../utils/linkDetection.js";

export async function handleMessageCreate(message) {
  const channel = message.channelId;
  const allInputChannels = channelService.getAllInputChannels();

  if (!allInputChannels.includes(channel)) {
    return;
  }

  if (!containsLink(message)) {
    console.log("Message does not contain a link, skipping...");
    return;
  }

  const results = await messageService.relayMessage(message, message.channel);

  // Log summary
  console.log(`📊 Forward Summary: ${results.successful}/${results.total} successful`);
  console.log(`   • Forwarded: ${results.forwardSent}, Failed: ${results.failed}`);

  if (results.failed > 0) {
    console.log(`   • Failed servers: ${results.failedServers
      .map((f) => f.serverId)
      .join(", ")}`);
  }
}