// Centralized Prompt Management System
// Provides a single source of truth for all prompts used in the application

const systemPrompts = require('./templates/system');
const enhancementPrompts = require('./templates/enhancement');
const ragPrompts = require('./templates/rag');
const chatPrompts = require('./templates/chat');
const agentPrompts = require('./templates/agent');

class PromptManager {
  constructor() {
    this.version = '1.0.0';
  }

  /**
   * Get a system prompt by type
   * @param {string} type - The type of system prompt ('default', 'copilot', 'rag', 'empty')
   * @returns {string} The system prompt
   */
  getSystemPrompt(type = 'default') {
    return systemPrompts[type] || systemPrompts.default;
  }

  /**
   * Get an enhancement prompt by variant
   * @param {string} variant - The variant of enhancement prompt ('default', 'simpleRewrite', etc.)
   * @returns {string} The enhancement prompt
   */
  getEnhancementPrompt(variant = 'default') {
    return enhancementPrompts[variant] || enhancementPrompts.default;
  }

  /**
   * Get the full enhancement instruction prompt with context
   * @param {string} systemPrompt - The system prompt context to include
   * @param {string} enhancedPrompt - Optional custom enhanced prompt to use instead of default
   * @returns {string} The complete enhancement instruction prompt
   */
  getEnhancementInstruction(systemPrompt = '', enhancedPrompt = null) {
    const basePrompt = enhancedPrompt || enhancementPrompts.default;
    const contextFormat = enhancementPrompts.contextFormat;
    
    // Replace {{system_prompt}} placeholder
    const formattedContext = contextFormat.replace('{{system_prompt}}', systemPrompt);
    
    return basePrompt + formattedContext;
  }

  /**
   * Get a RAG prompt component
   * @param {string} component - The RAG prompt component name
   * @returns {string} The RAG prompt component
   */
  getRagPrompt(component = 'defaultPrefix') {
    return ragPrompts[component] || ragPrompts.defaultPrefix;
  }

  /**
   * Format RAG documents with query
   * @param {string} query - The user query
   * @param {Array<string>} ragDocs - Array of RAG document strings
   * @param {string} promptWithHistory - Optional prompt with conversation history
   * @returns {string} Formatted RAG prompt
   */
  formatRagPrompt(query, ragDocs, promptWithHistory = null) {
    const docsText = ragDocs.join('\n\n');
    
    if (promptWithHistory) {
      return this.formatPrompt(ragPrompts.formatWithHistory, {
        prompt_with_history: promptWithHistory,
        rag_docs: docsText
      });
    } else {
      return this.formatPrompt(ragPrompts.formatWithoutHistory, {
        query: query,
        rag_docs: docsText
      });
    }
  }

  /**
   * Get enhancement context format template
   * @returns {string} The context format template
   */
  getEnhancementContextFormat() {
    return enhancementPrompts.contextFormat;
  }

  /**
   * Get a chat prompt by type
   * @param {string} type - The type of chat prompt
   * @returns {string} The chat prompt
   */
  getChatPrompt(type = 'titleGeneration') {
    return chatPrompts[type] || chatPrompts.titleGeneration;
  }

  /**
   * Format a prompt template with variables
   * @param {string} template - The template string with {{variable}} placeholders
   * @param {Object} variables - Object with variable names as keys and values
   * @returns {string} The formatted prompt
   */
  formatPrompt(template, variables = {}) {
    let prompt = template;
    Object.entries(variables).forEach(([key, value]) => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      prompt = prompt.replace(regex, value);
    });
    return prompt;
  }

  /**
   * Get simple query rewrite instruction
   * @returns {string} The simple rewrite instruction
   */
  getSimpleRewriteInstruction() {
    return enhancementPrompts.simpleRewrite;
  }

  /**
   * Get image context instruction
   * @param {string} systemPrompt - The system prompt to include
   * @returns {string} The image context instruction
   */
  getImageContextInstruction(systemPrompt = '') {
    if (!systemPrompt) return '';
    return enhancementPrompts.imageContext.replace('{{system_prompt}}', systemPrompt);
  }

  /**
   * Get an agent prompt by type
   * @param {string} type - The type of agent prompt ('taskPlanning', 'finalResponse', 'errorRecovery')
   * @returns {string} The agent prompt
   */
  getAgentPrompt(type = 'taskPlanning') {
    return agentPrompts[type] || agentPrompts.taskPlanning;
  }
}

// Export singleton instance
module.exports = new PromptManager();

