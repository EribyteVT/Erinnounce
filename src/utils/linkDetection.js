export function containsLink(message) {
  const urlRegex = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*\.[a-z]{2,}(?:\/[^\s<>]*)?)/gi;

  // Handle string input
  if (typeof message === "string") {
    return urlRegex.test(message);
  }

  let linkFound = false;
  const linkSources = [];

  // Check message content
  if (message.content && urlRegex.test(message.content)) {
    linkFound = true;
    linkSources.push("message content");
  }

  // Check embeds
  if (message.embeds && message.embeds.length > 0) {
    for (let i = 0; i < message.embeds.length; i++) {
      const embed = message.embeds[i];
      
      if (checkEmbedForLinks(embed, urlRegex)) {
        linkFound = true;
        linkSources.push(`embed ${i + 1}`);
      }
    }
  }

  // Check attachments
  if (message.attachments && message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      if (attachment.url && urlRegex.test(attachment.url)) {
        linkFound = true;
        linkSources.push("attachment URL");
      }
    }
  }

  console.log(`🔍 Link detection result: ${linkFound}`, {
    sources: linkSources,
    messageId: message.id || "unknown",
  });

  return linkFound;
}

function checkEmbedForLinks(embed, urlRegex) {
  const checkString = (str) => str && urlRegex.test(str);

  return (
    checkString(embed.url) ||
    checkString(embed.title) ||
    checkString(embed.description) ||
    (embed.fields && embed.fields.some(field => 
      checkString(field.name) || checkString(field.value)
    )) ||
    (embed.footer && checkString(embed.footer.text)) ||
    (embed.author && (checkString(embed.author.name) || checkString(embed.author.url)))
  );
}