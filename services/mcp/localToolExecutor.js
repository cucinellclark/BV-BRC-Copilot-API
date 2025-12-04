// services/mcp/localToolExecutor.js
// Handles execution of local pseudo-tools (meta-operations)

const { loadToolsForPrompt } = require('./toolDiscovery');
const { queryChatOnly } = require('../llmServices');
const { getModelData } = require('../dbUtils');
const { safeParseJson } = require('../jsonUtils');
const promptManager = require('../../prompts');

/**
 * Execute a local pseudo-tool
 * @param {string} toolId - Full tool ID (e.g., "local.create_workflow")
 * @param {object} parameters - Tool parameters
 * @param {object} context - Additional context (query, model, etc.)
 * @returns {Promise<object>} Tool execution result
 */
async function executeLocalTool(toolId, parameters = {}, context = {}) {
  console.log(`[Local Tool Executor] Executing: ${toolId}`);
  console.log(`[Local Tool Executor] Parameters:`, JSON.stringify(parameters, null, 2));
  
  switch (toolId) {
    case 'local.create_workflow':
      return await createWorkflowPlan(parameters, context);
    
    default:
      throw new Error(`Unknown local tool: ${toolId}`);
  }
}

/**
 * Create a detailed workflow plan without executing anything
 * @param {object} parameters - Tool parameters from LLM
 * @param {object} context - Execution context (query, model, etc.)
 * @returns {Promise<object>} Workflow plan structure
 */
async function createWorkflowPlan(parameters, context) {
  console.log('[Local Tool] Creating workflow plan...');
  
  const { query, model, system_prompt = '' } = context;
  const { query_summary, complexity_estimate = 'moderate' } = parameters;
  
  if (!query || !model) {
    throw new Error('Workflow creation requires query and model in context');
  }
  
  // Load available tools for the planning prompt
  const toolsDescription = await loadToolsForPrompt();
  
  // Build workflow planning prompt
  const workflowPrompt = promptManager.formatPrompt(
    promptManager.getAgentPrompt('workflowPlanning'),
    {
      tools: toolsDescription,
      query: query,
      query_summary: query_summary || query,
      complexity: complexity_estimate,
      systemPrompt: system_prompt || 'No additional context'
    }
  );
  
  // Get model data
  const modelData = await getModelData(model);
  
  // Call LLM to generate workflow plan
  const response = await queryChatOnly({
    query: workflowPrompt,
    model,
    system_prompt: 'You are a workflow planning expert for the BV-BRC platform. Always respond with valid JSON.',
    modelData
  });
  
  // Parse JSON response
  const workflowPlan = safeParseJson(response);
  
  console.log(`[Local Tool] Workflow plan created`);
  
  // Return the workflow plan as-is without validation
  return {
    type: 'workflow_plan',
    created_at: new Date().toISOString(),
    ...workflowPlan
  };
}

/**
 * Check if a tool ID is a local tool
 * @param {string} toolId - Tool ID to check
 * @returns {boolean} True if local tool
 */
function isLocalTool(toolId) {
  return toolId && toolId.startsWith('local.');
}

module.exports = {
  executeLocalTool,
  createWorkflowPlan,
  isLocalTool
};
