// services/mcp/utils/connectionUtils.js

const axios = require('axios');

class ConnectionUtils {
  static async testConnection(url, timeout = 30000) {
    try {
      const response = await axios.get(`${url}/health`, {
        timeout,
        validateStatus: status => status < 500
      });
      return { connected: true, status: response.status };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }

  static async makeRequest(url, method = 'GET', data = null, timeout = 30000) {
    try {
      const config = {
        method,
        url,
        timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      };

      if (data && (method === 'POST' || method === 'PUT')) {
        // If calling the MCP tool execution endpoint, format as JSON-RPC
        if (typeof url === 'string' && url.endsWith('/mcp/tools/call')) {
          const toolName = data && data.tool ? data.tool : undefined;
          const params = data && data.parameters ? data.parameters : {};
          config.data = {
            jsonrpc: '2.0',
            id: 1,
            name: toolName,
            params
          };
        } else {
          config.data = data;
        }
      }

      console.log('config', config);

      const response = await axios(config);

      console.log('response.data', response.data);

      return { success: true, data: response.data, status: response.status };
    } catch (error) {
      return { 
        success: false, 
        error: error.message, 
        status: error.response?.status || 500 
      };
    }
  }

}

module.exports = ConnectionUtils;
