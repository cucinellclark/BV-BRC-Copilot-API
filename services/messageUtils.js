// services/messageUtils.js

const { v4: uuidv4 } = require('uuid');

// Helper function to create message objects with consistent structure
function createMessage(role, content, tokenCount) {
  return {
    message_id: uuidv4(),
    role,
    content,
    timestamp: new Date()
  };
}

function createQueryFromMessages(query, messages, system_prompt, max_tokens) {
  const formattedMessages = [];

  if (system_prompt && system_prompt.trim() !== '') {
    formattedMessages.push(`System: ${system_prompt}`);
  }

  if (messages && messages.length > 0) {
    messages.forEach(msg => {
      if (msg.role && msg.content) {
        const roleLabel = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
        formattedMessages.push(`${roleLabel}: ${msg.content}`);
      }
    });
  }

  if (query && query.trim() !== '') {
    formattedMessages.push(`Current User Query: ${query}`);
  }

  return Promise.resolve(formattedMessages.join('\n\n'));
}

module.exports = {
  createMessage,
  createQueryFromMessages
}; 