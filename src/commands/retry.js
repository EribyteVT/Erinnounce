import { client } from "../index.js";
import { channelService } from "../services/channelService.js";
import { messageService } from "../services/messageService.js";
import { containsLink } from "../utils/linkDetection.js";

export async function handleRetryCommand(interaction) {
  const messageId = interaction.options.getString("message_id");

  await interaction.deferReply({ ephemeral: true });

  try {
    // Validate message ID format
    if (!/^\d{17,19}$/.test(messageId)) {
      await interaction.editReply({
        content: "❌ Invalid message ID format. Please provide a valid Discord message ID.",
      });
      return;
    }

    // Find the message
    const { message, channel } = await findMessage(messageId, interaction.channel);

    if (!message) {
      await interaction.editReply({
        content: "❌ Message not found. Make sure the message ID is correct.",
      });
      return;
    }

    // Validate it's from an input channel
    const allInputChannels = channelService.getAllInputChannels();
    if (!allInputChannels.includes(channel.id)) {
      await interaction.editReply({
        content: "❌ This message is not from a configured input channel.",
      });
      return;
    }

    // Check for links
    if (!containsLink(message)) {
      await interaction.editReply({
        content: "❌ This message does not contain any links.",
      });
      return;
    }

    await interaction.editReply({ content: "🔄 Starting message retry..." });

    // Relay the message
    const results = await messageService.relayMessage(message, channel);

    // Update with results
    const resultMessage = formatRetryResults(results);
    await interaction.editReply({ content: resultMessage });

    console.log(`📊 Retry Summary: ${results.successful}/${results.total} successful`);
  } catch (error) {
    console.error("Error in retry command:", error);
    await interaction.editReply({
      content: "❌ An error occurred while retrying the message.",
    });
  }
}

async function findMessage(messageId, currentChannel) {
  let targetMessage = null;
  let targetChannel = null;

  try {
    targetMessage = await currentChannel.messages.fetch(messageId);
    targetChannel = currentChannel;
  } catch (error) {
    // Search through all input channels
    const allInputChannels = channelService.getAllInputChannels();
    
    for (const channelId of allInputChannels) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel) {
          targetMessage = await channel.messages.fetch(messageId);
          targetChannel = channel;
          break;
        }
      } catch (searchError) {
        continue;
      }
    }
  }

  return { message: targetMessage, channel: targetChannel };
}

function formatRetryResults(results) {
  let message = `✅ **Retry Complete**\n`;
  message += `📊 **Summary:** ${results.successful}/${results.total} successful\n`;
  message += `• Forwarded: ${results.forwardSent} | Failed: ${results.failed}`;

  if (results.failed > 0) {
    message += `\n❌ **Failed Servers:** ${results.failedServers
      .map((f) => f.serverId)
      .join(", ")}`;
  }

  return message;
}