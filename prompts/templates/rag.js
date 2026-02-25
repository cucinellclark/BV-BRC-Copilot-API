// RAG (Retrieval-Augmented Generation) specific prompts

module.exports = {
  // Default RAG prompt prefix
  defaultPrefix: 'RAG retrieval results:\n',

  // User query prefix for RAG prompts
  queryPrefix: 'Current User Query: ',

  // Format for combining RAG documents with query
  formatWithHistory: '{{prompt_with_history}}\n\nRAG retrieval results:\n{{rag_docs}}',

  // Format for RAG without history
  formatWithoutHistory: 'Current User Query: {{query}}\n\nRAG retrieval results:\n{{rag_docs}}'
};

