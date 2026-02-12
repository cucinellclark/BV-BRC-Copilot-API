// services/mcp/contextAwareTools.js

const mcpConfig = require('./config.json');
const { createLogger } = require('../logger');

const logger = createLogger('ContextAwareTools');

/**
 * Check if a tool should receive context enhancement
 * @param {string} toolId - Full tool ID (e.g., "bvbrc_server.plan_workflow")
 * @returns {boolean}
 */
function isContextAwareTool(toolId) {
  const contextAwareTools = mcpConfig.global_settings?.context_aware_tools || [];
  return contextAwareTools.some(toolName => toolId.includes(toolName));
}

/**
 * Build enhanced context string from conversation data
 * @param {object} opts - Context building options
 * @returns {string} Formatted context string
 */
function buildEnhancedContext(opts = {}) {
  const {
    query = '',
    historyContext = '',
    sessionMemory = null,
    session_id = null
  } = opts;
  
  const parts = [];
  const maxTokens = mcpConfig.global_settings?.context_aware_settings?.max_context_tokens || 1000;
  
  parts.push('=== CONVERSATION CONTEXT ===');
  
  // Add current user query
  if (query) {
    parts.push(`\nCurrent User Query: ${truncateText(query, 200)}`);
  }
  
  // Extract and add summary from history context
  if (historyContext) {
    const summaryMatch = historyContext.match(/Conversation summary:\s*(.+?)(?=\n(?:user:|assistant:)|$)/s);
    if (summaryMatch) {
      const summary = summaryMatch[1].trim();
      parts.push(`\nConversation Summary:\n${truncateText(summary, 400)}`);
    }
    
    // Extract recent messages
    const recentMatch = historyContext.match(/Recent Messages:\s*(.+?)(?=\nCurrent Query:|$)/s);
    if (recentMatch) {
      const recent = recentMatch[1].trim();
      parts.push(`\nRecent Messages:\n${truncateText(recent, 300)}`);
    }
  }
  
  // Add session memory
  if (sessionMemory) {
    parts.push('\nSession State:');
    
    if (sessionMemory.focus) {
      parts.push(`- Focus: ${JSON.stringify(sessionMemory.focus)}`);
    }
    
    if (sessionMemory.last_tool) {
      parts.push(`- Last Tool Used: ${sessionMemory.last_tool.tool}`);
      if (sessionMemory.last_tool.parameters) {
        const params = JSON.stringify(sessionMemory.last_tool.parameters);
        if (params.length < 150) {
          parts.push(`  Parameters: ${params}`);
        }
      }
    }
    
    // Add key facts if available
    if (sessionMemory.facts && Object.keys(sessionMemory.facts).length > 0) {
      const factCount = Object.keys(sessionMemory.facts).length;
      parts.push(`- Session Facts: ${factCount} facts stored`);
      
      // Include most relevant facts (limit to 5)
      const factEntries = Object.entries(sessionMemory.facts).slice(0, 5);
      if (factEntries.length > 0) {
        factEntries.forEach(([key, value]) => {
          const valueStr = typeof value === 'object' 
            ? JSON.stringify(value) 
            : String(value);
          if (valueStr.length < 100) {
            parts.push(`  * ${key}: ${valueStr}`);
          }
        });
      }
    }
  }
  
  parts.push('\n=== TASK FOR THIS TOOL ===');
  
  const contextStr = parts.join('\n');
  
  // Rough token estimate (1 token ≈ 4 chars)
  const estimatedTokens = Math.ceil(contextStr.length / 4);
  
  if (estimatedTokens > maxTokens) {
    logger.warn('Context exceeds token limit, truncating', {
      estimatedTokens,
      maxTokens,
      contextLength: contextStr.length
    });
    return truncateText(contextStr, maxTokens * 4);
  }
  
  return contextStr;
}

/**
 * Truncate text to maximum length
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string}
 */
function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Apply context enhancement to tool parameters
 * @param {string} toolId - Full tool ID
 * @param {object} parameters - Original tool parameters from LLM
 * @param {object} context - Execution context
 * @param {object} toolDef - Tool definition with schema
 * @param {object} logger - Logger instance
 * @returns {object} Enhanced parameters
 */
function applyContextEnhancement(toolId, parameters = {}, context = {}, toolDef = null, logger = null) {
  const log = logger || createLogger('ContextAwareTools');
  
  try {
    // Verify tool has user_query parameter
    if (!toolDef?.inputSchema?.properties?.user_query) {
      log.debug('Tool does not have user_query parameter, skipping enhancement', { toolId });
      return parameters;
    }
    
    // Build enhanced context
    const enhancedContext = buildEnhancedContext({
      query: context.query,
      historyContext: context.historyContext,
      sessionMemory: context.sessionMemory,
      session_id: context.session_id
    });
    
    // Get original user_query from LLM
    const originalQuery = parameters.user_query || '';
    
    // Combine context with original query
    const enhancedQuery = enhancedContext 
      ? `${enhancedContext}\n${originalQuery}`
      : originalQuery;
    
    log.info('Enhanced context-aware tool query', {
      toolId,
      originalLength: originalQuery.length,
      enhancedLength: enhancedQuery.length,
      contextAdded: enhancedQuery.length - originalQuery.length
    });
    
    // Return modified parameters
    return {
      ...parameters,
      user_query: enhancedQuery
    };
    
  } catch (error) {
    log.error('Failed to enhance context for tool', {
      toolId,
      error: error.message,
      stack: error.stack
    });
    // Return original parameters on error
    return parameters;
  }
}

module.exports = {
  isContextAwareTool,
  buildEnhancedContext,
  applyContextEnhancement
};

