// services/mcp/mcpClient.js

const ServerManager = require('./serverManager');
const ToolRegistry = require('./toolRegistry');
const mcpConfig = require('./config.json');
const { handleMCPError } = require('./utils/errorHandling');

class MCPClient {
  constructor() {
    this.serverManager = new ServerManager();
    this.toolRegistry = new ToolRegistry();
    this.connectedServers = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      console.log('MCP Client already initialized');
      return;
    }

    console.log('Initializing MCP Client...');
    
    try {
      // Connect to all configured servers
      for (const [serverName, config] of Object.entries(mcpConfig.servers)) {
        await this.connectToServer(serverName, config);
      }
      
      this.initialized = true;
      console.log(`MCP Client initialized with ${this.connectedServers.size} servers`);
    } catch (error) {
      console.error('Failed to initialize MCP Client:', error.message);
      throw error;
    }
  }

  async connectToServer(serverName, config) {
    try {
      const connection = await this.serverManager.connect(config);
      const tools = await this.serverManager.getTools(connection);
      
      this.connectedServers.set(serverName, connection);
      this.toolRegistry.registerTools(serverName, tools);
      
      console.log(`Connected to MCP server: ${serverName} with ${tools.length} tools`);
    } catch (error) {
      const mcpError = handleMCPError(error, { serverName });
      console.error(`Failed to connect to ${serverName}:`, mcpError.message);
      // Don't throw - allow other servers to connect
    }
  }

  async executeTool(serverName, toolName, parameters = {}) {
    const connection = this.connectedServers.get(serverName);
    if (!connection) {
      throw new Error(`Server ${serverName} not connected`);
    }
    
    return await this.serverManager.executeTool(connection, toolName, parameters);
  }


  getAvailableTools() {
    return this.toolRegistry.getAllTools();
  }

  getToolsByServer(serverName) {
    return this.toolRegistry.getToolsByServer(serverName);
  }

  getToolByName(toolName) {
    return this.toolRegistry.getToolByName(toolName);
  }

  getToolsForPrompt() {
    return this.toolRegistry.getToolsForPrompt();
  }

  getConnectedServers() {
    return Array.from(this.connectedServers.keys());
  }

  isServerConnected(serverName) {
    return this.serverManager.isConnected(serverName);
  }

  async reconnectServer(serverName) {
    const config = mcpConfig.servers[serverName];
    if (!config) {
      throw new Error(`No configuration found for server: ${serverName}`);
    }
    
    await this.connectToServer(serverName, config);
  }

  // Extract tool calls from LLM response text
  extractToolCalls(text) {
    const toolCalls = [];
    
    // Look for patterns like: [TOOL:serverName:toolName:parameters]
    const toolCallRegex = /\[TOOL:([^:]+):([^:]+):([^\]]+)\]/g;
    let match;
    
    while ((match = toolCallRegex.exec(text)) !== null) {
      try {
        const [, serverName, toolName, paramString] = match;
        const parameters = JSON.parse(paramString);
        
        // Validate tool exists
        const tool = this.getToolByName(toolName);
        if (!tool) {
          console.warn(`Tool ${toolName} not found in available tools`);
          continue;
        }
        
        // Validate server matches
        if (tool.serverName !== serverName) {
          console.warn(`Tool ${toolName} server mismatch: expected ${tool.serverName}, got ${serverName}`);
          continue;
        }
        
        toolCalls.push({
          serverName,
          toolName,
          parameters,
          fullMatch: match[0]
        });
      } catch (error) {
        console.warn(`Failed to parse tool call: ${match[0]}`, error.message);
      }
    }
    
    return toolCalls;
  }

  // Track tool usage for analytics
  trackToolUsage(toolName, serverName, success, executionTime) {
    console.log(`Tool usage: ${toolName}@${serverName} - ${success ? 'success' : 'failed'} - ${executionTime}ms`);
  }

  // Get MCP tools context for LLM prompts
  getMCPToolsContext() {
    const tools = this.getToolsForPrompt();
    
    if (tools.length === 0) {
      return '';
    }
    
    const toolsDescription = tools.map(tool => 
      `- ${tool.name} (${tool.server}): ${tool.description}`
    ).join('\n');
    
    return `\n\nAvailable MCP Tools:\n${toolsDescription}`;
  }
}

// Create singleton instance
const mcpClient = new MCPClient();

module.exports = mcpClient;
