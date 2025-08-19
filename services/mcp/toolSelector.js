// services/mcp/toolSelector.js

const { queryRequestChat } = require('../llm/llmServices');
const { getModelData } = require('../chat/core/dbUtils');
const { MCPError } = require('./mcpClient');

class ToolSelectorError extends Error {
  constructor(message, originalError = null) {
    super(message);
    this.name = 'ToolSelectorError';
    this.originalError = originalError;
  }
}

class LLMToolSelector {
  constructor() {
    this.defaultModel = 'RedHatAI/Llama-4-Scout-17B-16E-Instruct-quantized.w4a16';
  }

  async selectTools(query, availableTools, model = this.defaultModel, authToken = null) {
    try {
      if (!availableTools || availableTools.length === 0) {
        return {
          tools: [],
          reasoning: 'No tools available for selection',
          confidence: 0
        };
      }

      const toolSelectionPrompt = this.buildToolSelectionPrompt(query, availableTools);
      const systemPrompt = this.getSystemPrompt();
      
      const modelData = await getModelData(model);
      
      const response = await queryRequestChat(
        modelData.endpoint,
        model,
        systemPrompt,
        toolSelectionPrompt
      );

      console.log('tool selection response: ', response);
      
      const result = this.parseToolSelection(response, availableTools);
      console.log(`🎯 Tool selection: ${result.tools.join(', ')} (confidence: ${result.confidence})`);
      return result;
    } catch (error) {
      if (error instanceof ToolSelectorError) {
        throw error;
      }
      throw new ToolSelectorError('Failed to select tools', error);
    }
  }

  getSystemPrompt() {
    return `You are a bioinformatics tool selector. Given a user query and available tools, select the most appropriate tools and provide reasoning.

      Respond in JSON format and only return the JSON object. Do NOT use markdown formatting, code blocks, or backticks. Return only the raw JSON object:
      {
        "selected_tools": ["tool_name1", "tool_name2", ...],
        "reasoning": "<explanation of why these tools were selected>",
        "confidence": <confidence_score>,
        "tool_arguments": {
          "tool_name1": {"arg1": "value1", "arg2": "value2", ...},
          "tool_name2": {"arg1": "value1", "arg2": "value2", ...},
          ...
        }
      }

      IMPORTANT: For each selected tool, extract any relevant arguments from the user query and include them in the tool_arguments object. If no specific arguments are mentioned for a tool, include an empty object {} for that tool.
      Make sure to include the required arguments for each tool. Conform to enum values if available.

      Only select tools that are clearly relevant to the query. If unsure, select fewer tools rather than more.`;
  }

  buildToolSelectionPrompt(query, availableTools) {
    const toolList = availableTools.map(tool => {
      let toolInfo = `- ${tool.name}: ${tool.description || 'No description available'}`;
      
      // Add parameter information if available
      if (tool.inputSchema && tool.inputSchema.properties) {
        const properties = tool.inputSchema.properties;
        const required = tool.inputSchema.required || [];
        
        toolInfo += `\n  Parameters:`;
        for (const [paramName, paramSchema] of Object.entries(properties)) {
          const isRequired = required.includes(paramName) ? ' (required)' : ' (optional)';
          const paramType = paramSchema.type || 'string';
          const paramDesc = paramSchema.description || 'No description';
          toolInfo += `\n    - ${paramName} (${paramType})${isRequired}: ${paramDesc}`;
          if (paramSchema.enum) {
            toolInfo += `\n    - Enum: ${paramSchema.enum.join(', ')}`;
          }
        }
      }
      
      // Add any additional tool metadata that might be useful
      if (tool.displayName && tool.displayName !== tool.name) {
        toolInfo += `\n  Display Name: ${tool.displayName}`;
      }
      
      console.log('toolInfo: ', toolInfo);

      return toolInfo;
    }).join('\n\n');

    return `User Query: "${query}"

Available Tools:
${toolList}

Select the most appropriate tools for this query and provide reasoning. For each selected tool, extract any relevant arguments from the user query and include them in the tool_arguments object.`;
  }

  parseToolSelection(response, availableTools) {
    try {
      // Strip markdown code blocks if present
      let cleanedResponse = response.trim();
      if (cleanedResponse.startsWith('```') && cleanedResponse.endsWith('```')) {
        // Remove opening and closing code blocks
        cleanedResponse = cleanedResponse.slice(3, -3);
        // Remove language identifier if present (e.g., ```json)
        const firstNewline = cleanedResponse.indexOf('\n');
        if (firstNewline !== -1) {
          cleanedResponse = cleanedResponse.slice(firstNewline + 1);
        }
        cleanedResponse = cleanedResponse.trim();
      }
      
      const parsed = JSON.parse(cleanedResponse);
      const selectedTools = parsed.selected_tools || [];
      const reasoning = parsed.reasoning || 'No reasoning provided';
      const confidence = Math.min(Math.max(parsed.confidence || 0.5, 0), 1);
      const toolArguments = parsed.tool_arguments || {};

      // Validate selected tools exist
      const validTools = selectedTools.filter(toolName => 
        availableTools.some(tool => tool.name === toolName)
      );

      return {
        tools: validTools,
        reasoning,
        confidence,
        tool_arguments: toolArguments
      };
    } catch (parseError) {
      console.error(`❌ Tool selection parse error: ${parseError.message}`);
      throw new ToolSelectorError(`Failed to parse LLM tool selection response: ${parseError.message}`);
    }
  }



  async extractToolArguments(query, toolName, model = this.defaultModel, availableTools = []) {
    try {
      // Find the tool schema
      const tool = availableTools.find(t => t.name === toolName);
      
      const extractionPrompt = this.buildArgumentExtractionPrompt(query, toolName, tool);
      const systemPrompt = this.getArgumentExtractionSystemPrompt(tool);
      
      const modelData = await getModelData(model);
      
      const response = await queryRequestChat(
        modelData.endpoint,
        model,
        systemPrompt,
        extractionPrompt
      );
      
      const result = this.parseToolArguments(response, toolName, tool);
      console.log(`📋 Extracted args for ${toolName}: ${JSON.stringify(result).substring(0, 100)}...`);
      return result;
    } catch (error) {
      console.error(`Failed to extract arguments for ${toolName}:`, error.message);
      throw new ToolSelectorError(`Failed to extract arguments for ${toolName}: ${error.message}`, error);
    }
  }

  getArgumentExtractionSystemPrompt(tool = null) {
    let basePrompt = `Extract arguments for tools from user queries. Respond in JSON format with only the arguments that are explicitly mentioned in the query. Do NOT use markdown formatting, code blocks, or backticks. Return only the raw JSON object.`;
    
    if (tool && tool.inputSchema && tool.inputSchema.properties) {
      basePrompt += `\n\nFor ${tool.name}, the expected parameters are:\n`;
      const properties = tool.inputSchema.properties;
      
      for (const [paramName, paramSchema] of Object.entries(properties)) {
        const paramType = paramSchema.type || 'string';
        const paramDescription = paramSchema.description || 'No description';
        const isRequired = tool.inputSchema.required?.includes(paramName) ? ' (required)' : ' (optional)';
        basePrompt += `- ${paramName} (${paramType}): ${paramDescription}${isRequired}\n`;
      }
      
      basePrompt += `\nExample format: ${JSON.stringify(this.getExampleArguments(tool), null, 2)}`;
    }
    
    basePrompt += `\n\nOnly extract values that are explicitly mentioned in the query. If a required parameter is not found in the query, use an empty string or appropriate default value.`;
    
    return basePrompt;
  }

  buildArgumentExtractionPrompt(query, toolName, tool = null) {
    let prompt = `Extract arguments for the tool "${toolName}" from this query: "${query}"`;
    
    if (tool && tool.description) {
      prompt += `\n\nTool description: ${tool.description}`;
    }
    
    return prompt;
  }

  parseToolArguments(response, toolName, tool = null) {
    try {
      return JSON.parse(response);
    } catch (error) {
      throw new ToolSelectorError(`Failed to parse tool arguments for ${toolName}: ${error.message}`);
    }
  }

  getDefaultArguments(toolName, tool = null) {
    if (tool && tool.inputSchema && tool.inputSchema.properties) {
      const defaults = {};
      const properties = tool.inputSchema.properties;
      
      for (const [paramName, paramSchema] of Object.entries(properties)) {
        if (paramSchema.default !== undefined) {
          defaults[paramName] = paramSchema.default;
        } else if (paramSchema.type === 'string') {
          defaults[paramName] = '';
        } else if (paramSchema.type === 'number' || paramSchema.type === 'integer') {
          defaults[paramName] = 0;
        } else if (paramSchema.type === 'boolean') {
          defaults[paramName] = false;
        } else if (paramSchema.type === 'array') {
          defaults[paramName] = [];
        } else if (paramSchema.type === 'object') {
          defaults[paramName] = {};
        } else {
          defaults[paramName] = null;
        }
      }
      
      return defaults;
    }

    // Fallback for legacy hardcoded tools
    switch (toolName) {
      case 'analyze_dna_sequence':
        return { sequence: '' };
      case 'analyze_protein_sequence':
        return { sequence: '' };
      case 'query_bvbrc_jobs':
        return {};
      default:
        return {};
    }
  }

  getExampleArguments(tool) {
    if (!tool || !tool.inputSchema || !tool.inputSchema.properties) {
      return {};
    }

    const example = {};
    const properties = tool.inputSchema.properties;
    
    for (const [paramName, paramSchema] of Object.entries(properties)) {
      if (paramSchema.example !== undefined) {
        example[paramName] = paramSchema.example;
      } else if (paramSchema.type === 'string') {
        if (paramName.toLowerCase().includes('sequence')) {
          example[paramName] = paramName.toLowerCase().includes('protein') ? 'MKLLVTA...' : 'ATCGATCG...';
        } else if (paramName.toLowerCase().includes('id')) {
          example[paramName] = '12345';
        } else {
          example[paramName] = 'example_value';
        }
      } else if (paramSchema.type === 'number' || paramSchema.type === 'integer') {
        example[paramName] = 123;
      } else if (paramSchema.type === 'boolean') {
        example[paramName] = true;
      } else if (paramSchema.type === 'array') {
        example[paramName] = ['item1', 'item2'];
      } else {
        example[paramName] = paramSchema.default || null;
      }
    }
    
    return example;
  }
}

module.exports = { LLMToolSelector, ToolSelectorError };