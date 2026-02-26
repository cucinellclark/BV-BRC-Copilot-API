// Query enhancement prompts for improving user queries with context

module.exports = {
  // Default instruction prompt for query enhancement (used in copilot context builder)
  default: 'You are an assistant that only outputs JSON. Do not write any explanatory text or natural language.\n' +
           'Your tasks are:\n' +
           '1. Store the original user query in the "query" field.\n' +
           '2. Rewrite the query as "enhancedQuery" by intelligently incorporating any *relevant* context provided, while preserving the original intent.\n' +
           '   - If the original query is vague (e.g., "describe this page") and appears to reference a page, tool, feature, or system, rewrite it to make the help-related intent clear.\n' +
           '   - If there is no relevant context or no need to enhance, copy the original query into "enhancedQuery".\n' +
           '3. Set "rag_helpdesk" to true if the query relates to helpdesk-style topics such as:\n' +
           '   - website functionality\n' +
           '   - troubleshooting\n' +
           '   - how-to questions\n' +
           '   - user issues or technical support needs\n' +
           '   - vague references to a page, tool, or feature that may require explanation or support\n' +
           '   - **any question mentioning the BV-BRC (Bacterial and Viral Bioinformatics Resource Center) or its functionality**\n\n',

  // Context and format instructions (appended to default enhancement prompt)
  contextFormat: '\n\nAdditional context for the page the user is on, as well as relevant data, is provided below. Use it only if it helps clarify or improve the query:\n' +
                 '{{system_prompt}}\n\n' +
                 'Return ONLY a JSON object in the following format:\n' +
                 '{\n' +
                 '  "query": "<original user query>",\n' +
                 '  "enhancedQuery": "<rewritten or same query>",\n' +
                 '  "rag_helpdesk": <true or false>\n' +
                 '}',

  // Simple query rewrite instruction (used in enhanceQuery function)
  simpleRewrite: 'You are an assistant that rewrites the user\'s query by augmenting it with any RELEVANT context provided. ' +
                 'The rewritten query must preserve the original intent while adding helpful detail. ' +
                 'If the additional context is not relevant, keep the query unchanged. ' +
                 'Respond ONLY with the rewritten query and nothing else.',

  // Additional context instruction for image-based enhancement
  imageContext: '\n\nTextual context you may use if relevant:\n{{system_prompt}}'
};

