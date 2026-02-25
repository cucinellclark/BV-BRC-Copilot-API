// System prompts for different use cases

module.exports = {
  // Default system prompt for general chat
  default: 'You are a helpful assistant that can answer questions.',

  // Copilot-specific system prompt
  copilot: 'You are a helpful AI assistant specialized in BV-BRC (Bacterial and Viral Bioinformatics Resource Center) functionality.',

  // RAG-specific system prompt
  rag: 'You are a helpful AI assistant that can answer questions. ' +
       'You are given a list of documents and a user query. ' +
       'You need to answer the user query based on the documents if those documents are relevant to the user query. ' +
       'If they are not relevant, you need to answer the user query based on your knowledge.',

  // Empty system prompt (for cases where no system prompt is needed)
  empty: ''
};

