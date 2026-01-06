// services/mcp/localToolExecutor.js
// Handles execution of local pseudo-tools (meta-operations)

const { loadToolsForPrompt } = require('./toolDiscovery');
const { queryChatOnly } = require('../llmServices');
const { getModelData } = require('../dbUtils');
const { safeParseJson } = require('../jsonUtils');
const { fileManager } = require('../fileManager');
const { createLogger } = require('../logger');
const promptManager = require('../../prompts');

/**
 * Execute a local pseudo-tool
 * @param {string} toolId - Full tool ID (e.g., "local.create_workflow")
 * @param {object} parameters - Tool parameters
 * @param {object} context - Additional context (query, model, etc.)
 * @param {Logger} logger - Optional logger instance
 * @returns {Promise<object>} Tool execution result
 */
async function executeLocalTool(toolId, parameters = {}, context = {}, logger = null) {
  const log = logger || createLogger('LocalTool', context.session_id);
  
  log.info('Executing local tool', { toolId, parameters });
  
  // Check if tool is disabled
  const { getToolDefinition } = require('./toolDiscovery');
  const toolDef = await getToolDefinition(toolId);
  if (!toolDef || toolDef.disabled) {
    log.error('Tool is disabled or not found', { toolId });
    throw new Error(`Tool ${toolId} is disabled or not available`);
  }
  
  switch (toolId) {
    case 'local.create_workflow':
      return await createWorkflowPlan(parameters, context, log);
    
    case 'local.get_file_info':
      return await getFileInfo(parameters, context, log);
    
    default:
      log.error('Unknown local tool', { toolId });
      throw new Error(`Unknown local tool: ${toolId}`);
  }
}

/**
 * Create a detailed workflow plan without executing anything
 * @param {object} parameters - Tool parameters from LLM
 * @param {object} context - Execution context (query, model, etc.)
 * @param {Logger} logger - Logger instance
 * @returns {Promise<object>} Workflow plan structure
 */
async function createWorkflowPlan(parameters, context, logger) {
  logger.info('Creating workflow plan', { parameters });
  
  const { query, model, system_prompt = '' } = context;
  const { query_summary, complexity_estimate = 'moderate' } = parameters;
  
  if (!query || !model) {
    logger.error('Workflow creation requires query and model in context');
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
  
  // Log the prompt
  logger.logPrompt('Workflow Planning', workflowPrompt, model, {
    query_summary,
    complexity_estimate
  });
  
  // Get model data
  const modelData = await getModelData(model);
  
  // Call LLM to generate workflow plan
  const response = await queryChatOnly({
    query: workflowPrompt,
    model,
    system_prompt: 'You are a workflow planning expert for the BV-BRC platform. Always respond with valid JSON.',
    modelData
  });
  
  // Log the response
  logger.logResponse('Workflow Planning', response, model);
  
  // Parse JSON response
  const workflowPlan = safeParseJson(response);
  
  logger.info('Workflow plan created', { 
    stepsCount: workflowPlan?.steps?.length 
  });
  
  // Return the workflow plan as-is without validation
  return {
    type: 'workflow_plan',
    created_at: new Date().toISOString(),
    ...workflowPlan
  };
}

/**
 * Get detailed information about a saved file
 * @param {object} parameters - Tool parameters from LLM
 * @param {object} context - Execution context (session_id, etc.)
 * @param {Logger} logger - Logger instance
 * @returns {Promise<object>} File metadata
 */
async function getFileInfo(parameters, context, logger) {
  logger.info('Getting file info', { parameters });
  
  const { fileId } = parameters;
  const { session_id } = context;
  
  if (!fileId) {
    logger.error('fileId is required');
    throw new Error('fileId is required');
  }
  
  if (!session_id) {
    logger.error('session_id is required in context');
    throw new Error('session_id is required in context');
  }
  
  try {
    const fileInfo = await fileManager.getFileInfo(session_id, fileId);
    
    logger.info('File info retrieved', { 
      fileId, 
      fileName: fileInfo.fileName,
      dataType: fileInfo.dataType 
    });
    
    // Format response with helpful context
    return {
      ...fileInfo,
      availableActions: getAvailableActionsForDataType(fileInfo.dataType),
      note: 'Use internal_server file tools to query, search, or extract data from this file'
    };
  } catch (error) {
    logger.error('Failed to get file info', { 
      fileId, 
      error: error.message, 
      stack: error.stack 
    });
    throw new Error(`Failed to get file info: ${error.message}`);
  }
}

/**
 * Get available internal_server actions based on data type
 * @param {string} dataType - The data type from file metadata
 * @returns {Array<string>} List of available action tools
 */
function getAvailableActionsForDataType(dataType) {
  const baseActions = [
    'internal_server.read_file_lines',
    'internal_server.search_file'
  ];

  switch (dataType) {
    case 'json_array':
    case 'json_object':
      return [
        ...baseActions,
        'internal_server.query_json',
        'internal_server.get_file_statistics'
      ];
    
    case 'csv':
    case 'tsv':
      return [
        ...baseActions,
        'internal_server.extract_csv_columns',
        'internal_server.get_file_statistics'
      ];
    
    case 'text':
      return baseActions;
    
    default:
      return baseActions;
  }
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
  getFileInfo,
  isLocalTool
};
