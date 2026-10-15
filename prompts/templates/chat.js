// Chat-specific prompts and message formatting

module.exports = {
  // Title generation prompt
  // The frontend sends only the user's first message (2026-10-15): titles
  // made from the whole exchange described the answer, not the request.
  titleGeneration: 'Write a short title (at most 8 words) for a chat that ' +
                   'starts with the user request below. Name the task or ' +
                   'question being asked, not an answer to it. Only return ' +
                   'the title, with no quotes or other text.',

  // Message formatting templates
  formatSystem: 'System: {{content}}',
  formatUser: 'User: {{content}}',
  formatAssistant: 'Assistant: {{content}}',
  formatCurrentQuery: 'Current User Query: {{query}}'
};

