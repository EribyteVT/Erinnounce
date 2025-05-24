import { containsLink } from "./linkDetection.js";

export function debugMessage(message, label = "Message Debug") {
  console.log(`\n🐛 ${label} - Message Analysis:`);
  console.log(`   Message ID: ${message.id}`);
  console.log(`   Author: ${message.author.username}`);
  console.log(`   Content Length: ${message.content ? message.content.length : 0}`);
  console.log(`   Has Content: ${!!message.content}`);
  console.log(`   Embed Count: ${message.embeds ? message.embeds.length : 0}`);
  console.log(`   Attachment Count: ${message.attachments ? message.attachments.size : 0}`);

  if (message.content) {
    console.log(`   Content Preview: "${message.content.substring(0, 100)}${
      message.content.length > 100 ? "..." : ""
    }"`);
  }

  if (message.embeds && message.embeds.length > 0) {
    console.log(`\n   📎 Embed Details:`);
    message.embeds.forEach((embed, index) => {
      logEmbedDetails(embed, index);
    });
  }

  if (message.attachments && message.attachments.size > 0) {
    console.log(`\n   📎 Attachment Details:`);
    message.attachments.forEach((attachment, index) => {
      console.log(`     Attachment ${index + 1}: ${attachment.name} (${attachment.url})`);
    });
  }

  console.log(`\n   🔗 Overall Link Detection: ${containsLink(message)}\n`);
}

function logEmbedDetails(embed, index) {
  console.log(`     Embed ${index + 1}:`);
  console.log(`       Title: ${embed.title ? `"${embed.title}"` : "None"}`);
  console.log(`       Description: ${
    embed.description ? `"${embed.description.substring(0, 50)}..."` : "None"
  }`);
  console.log(`       URL: ${embed.url || "None"}`);
  console.log(`       Color: ${embed.color || "None"}`);
  console.log(`       Timestamp: ${embed.timestamp || "None"}`);
  console.log(`       Fields: ${embed.fields ? embed.fields.length : 0}`);
  console.log(`       Author: ${embed.author ? embed.author.name : "None"}`);
  console.log(`       Thumbnail: ${embed.thumbnail ? embed.thumbnail.url : "None"}`);
  console.log(`       Image: ${embed.image ? embed.image.url : "None"}`);
  console.log(`       Footer: ${embed.footer ? embed.footer.text : "None"}`);
  
  const embedHasLinks = containsLink({ embeds: [embed] });
  console.log(`       Contains Links: ${embedHasLinks}`);
}