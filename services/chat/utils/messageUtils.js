// services/messageUtils.js

const config = require('../../../config.json');
const { v4: uuidv4 } = require('uuid');
const { postJson } = require('../../llm/llmServices');

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
  return new Promise(async (resolve, reject) => {
    try {
      const data = await postJson(`${config.utilities_url}/get_prompt_query`, {
        query: query || '',
        messages: messages || [],
        system_prompt: system_prompt || '',
        max_tokens: 40000
      });

      resolve(data.prompt_query);
    } catch (error) {
      console.error('Error in createQueryFromMessages:', error);
      
      // Fallback: format messages according to their roles
      let formattedMessages = [];
      
      // Add system prompt if provided
      if (system_prompt && system_prompt.trim() !== '') {
        formattedMessages.push(`System: ${system_prompt}`);
      }
      
      // Format existing messages according to their roles
      if (messages && messages.length > 0) {
        messages.forEach(msg => {
          if (msg.role && msg.content) {
            const roleLabel = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
            formattedMessages.push(`${roleLabel}: ${msg.content}`);
          }
        });
      }
      
      // Add the current query as the final message
      if (query && query.trim() !== '') {
        formattedMessages.push(`Current User Query: ${query}`);
      }
      
      const fallbackResponse = formattedMessages.join('\n\n');
      resolve(fallbackResponse);
    }
  });
}

module.exports = {
  createMessage,
  createQueryFromMessages
}; 