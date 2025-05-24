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
      await messageService.sendErrorResponse(interaction,
        "Invalid message ID format. Please provide a valid Discord message ID."
      );
      return;
    }

    // Find the message
    const { message, channel } = await findMessage(messageId, interaction.channel);

    if (!message) {
      await messageService.sendErrorResponse(interaction,
        "Message not found. Make sure the message ID is correct."
      );
      return;
    }

    // Validate it's from an input channel
    const allInputChannels = channelService.getAllInputChannels();
    if (!allInputChannels.includes(channel.id)) {
      await messageService.sendErrorResponse(interaction,
        "This message is not from a configured input channel."
      );
      return;
    }

    // Check for links
    if (!containsLink(message)) {
      await messageService.sendErrorResponse(interaction,
        "This message does not contain any links."
      );
      return;
    }

    // Show progress
    await messageService.sendInfoResponse(interaction, 
      "🔄 Starting message retry via webhooks...",
      { title: "Retry Command" }
    );

    // Relay the message
    const results = await messageService.relayMessage(message, channel);

    // Update with results
    const resultMessage = formatRetryResults(results);
    await messageService.sendSuccessResponse(interaction, resultMessage, {
      title: "✅ Retry Complete"
    });

    console.log(`📊 Retry Summary: ${results.successful}/${results.total} successful`);
  } catch (error) {
    console.error("Error in retry command:", error);
    await messageService.sendErrorResponse(interaction,
      "An error occurred while retrying the message."
    );
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
  let message = `**Summary:** ${results.successful}/${results.total} successful\n`;
  message += `• Forwarded: ${results.forwardSent} | Failed: ${results.failed}`;

  if (results.failed > 0) {
    message += `\n❌ **Failed Servers:** ${results.failedServers
      .map((f) => f.serverId)
      .join(", ")}`;
  }

  return message;
}