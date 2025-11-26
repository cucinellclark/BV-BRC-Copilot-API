// Chat-specific prompts and message formatting

module.exports = {
  // Title generation prompt
  titleGeneration: 'Provide a very short, concise, descriptive title based on the content ' +
                   'of the messages. Only return the title, no other text.',

  // Message formatting templates
  formatSystem: 'System: {{content}}',
  formatUser: 'User: {{content}}',
  formatAssistant: 'Assistant: {{content}}',
  formatCurrentQuery: 'Current User Query: {{query}}'
};

