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
      
      // 3. Execute selected tools
      const toolResults = [];
      const toolErrors = [];
      
      // 3. Execute selected tools
      for (const toolName of selectedTools) {
        try {
          const result = await this.mcpClient.callTool(toolName, null, auth_token);
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