// services/mcp/mcpOrchestrator.js

const { BVBRCMCPClient, MCPError } = require('./mcpClient');
const { LLMToolSelector, ToolSelectorError } = require('./toolSelector');
const { getModelData } = require('../chat/core/dbUtils');
const { queryRequestChat } = require('../llm/llmServices');

class MCPOrchestratorError extends Error {
  constructor(message, originalError = null) {
    super(message);
    this.name = 'MCPOrchestratorError';
    this.originalError = originalError;
  }
}

class MCPOrchestrator {
  constructor() {
    this.mcpClient = new BVBRCMCPClient();
    this.toolSelector = new LLMToolSelector();
  }

  async processQuery(query, options = {}) {
    const startTime = Date.now();
    const {
      auth_token = options.auth_token || null,
      model = 'RedHatAI/Llama-4-Scout-17B-16E-Instruct-quantized.w4a16',
      max_tools = 3,
      include_reasoning = true,
      stream_response = false
    } = options;

    try {
      // 1. Get available tools
      const availableTools = await this.mcpClient.getAvailableTools(auth_token);

      // 2. Select appropriate tools
      const selection = await this.toolSelector.selectTools(query, availableTools, model, auth_token);
      const selectedTools = selection.tools.slice(0, max_tools);
      console.log(`🤖 Selected ${selectedTools.length}/${availableTools.length} tools: [${selectedTools.join(', ')}]`);
      console.log(`📋 Tool arguments from selection: ${JSON.stringify(selection.tool_arguments)}`);
      
      // 3. Execute selected tools
      const toolResults = [];
      const toolErrors = [];
      
      // 3. Execute selected tools with arguments
      for (const toolName of selectedTools) {
        try {
          // Get arguments for this tool from the selection result
          let toolArgs = selection.tool_arguments[toolName] || {};
          
          // If no arguments were provided, try to extract them from the query
          if (Object.keys(toolArgs).length === 0) {
            try {
              console.log(`🔍 No arguments found for ${toolName}, attempting to extract from query...`);
              toolArgs = await this.toolSelector.extractToolArguments(query, toolName, model, availableTools);
            } catch (extractError) {
              console.warn(`⚠️ Failed to extract arguments for ${toolName}: ${extractError.message}`);
              toolArgs = {};
            }
          }
          
          // Validate and clean tool arguments
          if (typeof toolArgs !== 'object' || toolArgs === null) {
            console.warn(`⚠️ Invalid arguments for ${toolName}, using empty object`);
            toolArgs = {};
          }
          
          console.log(`🔧 Executing ${toolName} with args: ${JSON.stringify(toolArgs)}`);
          
          const result = await this.mcpClient.callTool(toolName, toolArgs, auth_token);
          console.log(`🔍 Received result from callTool for ${toolName}:`, JSON.stringify(result, null, 2));
          
          // Add arguments to the result for reference
          result.arguments = toolArgs;
          
          // Truncate large results for logging
          const resultSummary = JSON.stringify(result.result).substring(0, 150);
          console.log(`✅ ${toolName}: ${resultSummary}${JSON.stringify(result.result).length > 150 ? '...' : ''}`);
          toolResults.push(result);
        } catch (toolError) {
          console.error(`❌ ${toolName} failed: ${toolError.message}`);
          toolErrors.push({
            tool: toolName,
            error: toolError.message
          });
        }
      }
      console.log(`🏁 Execution complete: ${toolResults.length} success, ${toolErrors.length} errors`);

      // 4. Generate natural language response
      const responseText = await this.generateResponse(query, toolResults, model);
      
      const processingTime = Date.now() - startTime;
      
      return {
        success: true,
        response: responseText,
        tools_used: selectedTools,
        tool_results: toolResults,
        tool_errors: toolErrors.length > 0 ? toolErrors : undefined,
        tool_arguments: selection.tool_arguments,
        selection_reasoning: include_reasoning ? selection.reasoning : undefined,
        metadata: {
          processing_time_ms: processingTime,
          tools_available: availableTools.length,
          confidence: selection.confidence,
          mcp_server_healthy: await this.mcpClient.healthCheck()
        }
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      if (error instanceof MCPError || error instanceof ToolSelectorError) {
        return {
          success: false,
          error: error.message,
          error_type: error.name,
          metadata: {
            processing_time_ms: processingTime,
            mcp_server_healthy: await this.mcpClient.healthCheck()
          }
        };
      }
      
      throw new MCPOrchestratorError('Failed to process MCP query', error);
    }
  }

  async generateResponse(query, toolResults, model) {
    try {
      if (toolResults.length === 0) {
        throw new MCPOrchestratorError(`No tools were executed successfully for query: "${query}"`);
      }

      const responsePrompt = this.buildResponsePrompt(query, toolResults);
      const systemPrompt = this.getResponseSystemPrompt();
      const modelData = await getModelData(model);
      console.log('modelData', modelData);
      console.log('responsePrompt', responsePrompt);
      console.log('systemPrompt', systemPrompt);
      console.log('model', model);
      const response = await queryRequestChat(
        modelData.endpoint,
        model,
        systemPrompt,
        responsePrompt
      );
      console.log(`📝 Generated response (${response.length} chars): ${response.substring(0, 100)}...`);
      return response;
    } catch (error) {
      console.error('Failed to generate natural language response:', error.message);
      throw new MCPOrchestratorError(`Failed to generate response: ${error.message}`, error);
    }
  }

  getResponseSystemPrompt() {
    return `You are a bioinformatics assistant. Generate a natural, helpful response based on tool execution results.

Guidelines:
- Explain results in clear, scientific language
- Include specific numerical results when available
- If tools failed, explain what went wrong
- Be concise but informative
- Use proper scientific terminology`;
  }

  buildResponsePrompt(query, toolResults) {
    let prompt = `User Query: "${query}"\n\nTool Execution Results:\n`;
    
    toolResults.forEach((result, index) => {
      prompt += `\n${index + 1}. Tool: ${result.tool}\n`;
      prompt += `   Success: ${result.success}\n`;
      if (result.arguments) {
        prompt += `   Arguments: ${JSON.stringify(result.arguments, null, 2)}\n`;
      }
      prompt += `   Result: ${JSON.stringify(result.result, null, 2)}\n`;
      if (result.execution_time) {
        prompt += `   Execution Time: ${result.execution_time}ms\n`;
      }
    });
    
    prompt += '\nGenerate a natural language response explaining these results to the user.';
    return prompt;
  }



  async validateSequence(sequence, type = 'dna') {
    if (!sequence || typeof sequence !== 'string') {
      return { valid: false, error: 'Sequence must be a non-empty string' };
    }

    const cleanSequence = sequence.replace(/\s/g, '').toUpperCase();
    
    if (type === 'dna') {
      const validDNA = /^[ATGC]+$/;
      if (!validDNA.test(cleanSequence)) {
        return { valid: false, error: 'DNA sequence must contain only A, T, G, C characters' };
      }
    } else if (type === 'protein') {
      const validProtein = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
      if (!validProtein.test(cleanSequence)) {
        return { valid: false, error: 'Protein sequence must contain only valid amino acid characters' };
      }
    }

    return { valid: true, sequence: cleanSequence };
  }
}

module.exports = { MCPOrchestrator, MCPOrchestratorError };