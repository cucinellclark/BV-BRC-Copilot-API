// services/mcp/serverManager.js

const ConnectionUtils = require('./utils/connectionUtils');
const { MCPConnectionError, MCPToolExecutionError, handleMCPError } = require('./utils/errorHandling');

class ServerManager {
  constructor() {
    this.connections = new Map(); // serverName -> connection info
    this.retryAttempts = 3;
    this.retryDelay = 5000;
  }

  async connect(serverConfig) {
    const { name, url, timeout = 30000 } = serverConfig;
    
    try {
      // Test basic connectivity by trying to get tools
      const toolsResult = await ConnectionUtils.makeRequest(
        `${url}/mcp/tools/list`,
        'GET',
        null,
        timeout
      );

      if (!toolsResult.success) {
        throw new MCPConnectionError(`Failed to connect to ${name}: ${toolsResult.error}`, name, new Error(toolsResult.error));
      }

      const connection = {
        name,
        url,
        connected: true,
        capabilities: {}, // No capabilities endpoint available
        connectedAt: new Date(),
        lastPing: new Date()
      };

      this.connections.set(name, connection);
      console.log(`Successfully connected to MCP server: ${name}`);
      return connection;

    } catch (error) {
      const mcpError = handleMCPError(error, { serverName: name });
      console.error(`Failed to connect to MCP server ${name}:`, mcpError.message);
      throw mcpError;
    }
  }

  async getTools(connection) {
    try {
      const result = await ConnectionUtils.makeRequest(
        `${connection.url}/mcp/tools/list`,
        'GET',
        null,
        connection.timeout || 30000
      );

      if (!result.success) {
        throw new Error(`Failed to fetch tools: ${result.error}`);
      }

      return result.data.tools || [];
    } catch (error) {
      const mcpError = handleMCPError(error, { serverName: connection.name });
      console.error(`Failed to get tools from ${connection.name}:`, mcpError.message);
      return [];
    }
  }

  async executeTool(connection, toolName, parameters = {}) {
    try {
      const requestData = {
        tool: toolName,
        parameters
      };

      const result = await ConnectionUtils.makeRequest(
        `${connection.url}/mcp/tools/call`,
        'POST',
        requestData,
        60000 // 60 second timeout for tool execution
      );

      if (!result.success) {
        throw new MCPToolExecutionError(
          `Tool execution failed: ${result.error}`,
          connection.name,
          toolName
        );
      }

      // Update last ping
      if (this.connections.has(connection.name)) {
        this.connections.get(connection.name).lastPing = new Date();
      }

      return result.data;
    } catch (error) {
      const mcpError = handleMCPError(error, { 
        serverName: connection.name, 
        toolName 
      });
      console.error(`Tool execution failed on ${connection.name}.${toolName}:`, mcpError.message);
      throw mcpError;
    }
  }


  getConnection(serverName) {
    return this.connections.get(serverName);
  }

  getAllConnections() {
    return Array.from(this.connections.values());
  }

  isConnected(serverName) {
    const connection = this.connections.get(serverName);
    return connection && connection.connected;
  }

  disconnect(serverName) {
    const connection = this.connections.get(serverName);
    if (connection) {
      connection.connected = false;
      console.log(`Disconnected from MCP server: ${serverName}`);
    }
  }

  async reconnect(serverName, serverConfig) {
    this.disconnect(serverName);
    return await this.connect(serverConfig);
  }
}

module.exports = ServerManager;
