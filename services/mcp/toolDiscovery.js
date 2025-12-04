// services/mcp/toolDiscovery.js

const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { sessionManager } = require('./mcpSessionManager');

const MCP_CONFIG_PATH = path.join(__dirname, 'config.json');
const TOOLS_MANIFEST_PATH = path.join(__dirname, 'tools.json');
const TOOLS_PROMPT_PATH = path.join(__dirname, 'tools-for-prompt.txt');
const LOCAL_TOOLS_PATH = path.join(__dirname, 'local-tools.json');

/**
 * Discover tools from all configured MCP servers
 * Called on API startup
 */
async function discoverTools() {
  console.log('[MCP Tool Discovery] Starting...');
  
  try {
    // Load MCP config
    const configFile = await fs.readFile(MCP_CONFIG_PATH, 'utf8');
    const config = JSON.parse(configFile);
    
    const toolsManifest = {
      discovered_at: new Date().toISOString(),
      servers: {},
      tools: {},
      tool_count: 0
    };
    
    // Fetch tools from each server (skip disabled servers)
    const enabledServers = Object.entries(config.servers).filter(
      ([serverKey, serverConfig]) => !serverConfig.disabled
    );
    
    // Fetch tools from enabled servers only
    const serverPromises = enabledServers.map(
      ([serverKey, serverConfig]) => {
        return fetchServerTools(serverKey, serverConfig, config.global_settings, config.auth_token);
      }
    );
    
    const serverResults = await Promise.allSettled(serverPromises);
    
    // Aggregate results
    serverResults.forEach((result, index) => {
      const [serverKey, serverConfig] = enabledServers[index];
      
      if (result.status === 'fulfilled' && result.value) {
        const { tools, metadata } = result.value;
        
        toolsManifest.servers[serverKey] = {
          status: 'connected',
          tool_count: tools.length,
          ...metadata
        };
        
        // Add tools to manifest
        tools.forEach(tool => {
          const toolId = `${serverKey}.${tool.name}`;
          toolsManifest.tools[toolId] = {
            ...tool,
            server: serverKey,
            server_url: config.servers[serverKey].url
          };
          toolsManifest.tool_count++;
        });
        
        console.log(`[MCP Tool Discovery] ✓ ${serverKey}: ${tools.length} tools`);
      } else {
        toolsManifest.servers[serverKey] = {
          status: 'failed',
          error: result.reason?.message || 'Unknown error'
        };
        console.error(`[MCP Tool Discovery] ✗ ${serverKey}: ${result.reason?.message}`);
      }
    });
    
    // Write manifest file (machine-readable)
    await fs.writeFile(
      TOOLS_MANIFEST_PATH,
      JSON.stringify(toolsManifest, null, 2)
    );
    
    // Write prompt-optimized file (human/LLM-readable) with local tools appended
    await writeToolsForPrompt(toolsManifest);
    
    console.log(`[MCP Tool Discovery] Complete. ${toolsManifest.tool_count} tools from ${enabledServers.length} server(s)`);
    
    return toolsManifest;
  } catch (error) {
    console.error('[MCP Tool Discovery] Failed:', error);
    throw error;
  }
}

/**
 * Fetch tools from a single MCP server using JSON-RPC
 * Uses the shared mcpExecutor session manager to avoid duplication
 */
async function fetchServerTools(serverKey, serverConfig, globalSettings, authToken) {
  const mcpEndpoint = `${serverConfig.url}/mcp`;
  const retryAttempts = globalSettings?.connection_retry_attempts || 3;
  const retryDelay = globalSettings?.connection_retry_delay || 5000;
  
  // Check if this server should receive the auth token
  const allowlist = globalSettings?.token_server_allowlist || [];
  const shouldIncludeToken = allowlist.includes(serverKey);
  
  let lastError;
  
  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      // Use shared session manager (creates/reuses session)
      const sessionId = await sessionManager.getOrCreateSession(
        serverKey,
        serverConfig,
        authToken
      );
      
      console.log(`[MCP Tool Discovery] Using session ${sessionId} for ${serverKey}`);
      
      // Build headers with session ID
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-session-id': sessionId
      };
      
      // Add auth token if server is in allowlist
      if (shouldIncludeToken && authToken) {
        headers['Authorization'] = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;
      }
      
      // Fallback to server-specific auth if configured
      if (serverConfig.auth) {
        headers['Authorization'] = serverConfig.auth.startsWith('Bearer ') ? serverConfig.auth : `Bearer ${serverConfig.auth}`;
      }
      
      // Request tools list (session already initialized by session manager)
      const toolsRequest = {
        jsonrpc: '2.0',
        id: `discovery-${serverKey}-${Date.now()}`,
        method: 'tools/list',
        params: {}
      };
      
      const response = await axios.post(mcpEndpoint, toolsRequest, {
        timeout: serverConfig.timeout || 10000,
        headers,
        withCredentials: true
      });
      
      // Parse SSE format response if needed
      let responseData = response.data;
      if (typeof responseData === 'string') {
        const dataMatch = responseData.match(/data: (.+?)(?:\r?\n|$)/);
        if (dataMatch && dataMatch[1]) {
          responseData = JSON.parse(dataMatch[1]);
        }
      }
      
      console.log(`[MCP Tool Discovery] Discovered ${responseData.result?.tools?.length || 0} tools from ${serverKey}`);
      
      // Check for JSON-RPC error
      if (responseData.error) {
        throw new Error(`JSON-RPC error: ${responseData.error.message || JSON.stringify(responseData.error)}`);
      }
      
      // Extract tools from JSON-RPC result
      const tools = responseData.result?.tools || [];
      
      return {
        tools,
        metadata: {
          server_name: serverConfig.name,
          server_description: serverConfig.description,
          discovered_at: new Date().toISOString()
        }
      };
    } catch (error) {
      lastError = error;
      const errorMsg = error.response?.data?.error?.message || error.message;
      console.error(`[MCP Tool Discovery] ${serverKey} attempt ${attempt} failed: ${errorMsg}`);
      
      // Clear session on error so it retries initialization
      if (error.message.includes('session') || error.message.includes('Session')) {
        console.log(`[MCP Tool Discovery] Clearing session for ${serverKey} due to session error`);
        sessionManager.clearSession(serverKey);
      }
      
      if (attempt < retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  throw new Error(`Failed to connect to ${serverKey} after ${retryAttempts} attempts: ${lastError.message}`);
}

/**
 * Write tools in a format optimized for LLM prompts (includes local tools)
 */
async function writeToolsForPrompt(manifest) {
  let promptText = `# Available MCP Tools (${manifest.tool_count} total)\n`;
  promptText += `# Last Updated: ${manifest.discovered_at}\n\n`;
  promptText += `**IMPORTANT: When using tools, you MUST use the full tool ID format: server_name.tool_name**\n\n`;
  
  // Group by server (only include enabled and connected servers)
  Object.entries(manifest.servers).forEach(([serverKey, serverInfo]) => {
    if (serverInfo.status !== 'connected') return; // Skip disabled and failed servers
    
    promptText += `## ${serverInfo.server_name}\n`;
    promptText += `${serverInfo.server_description}\n\n`;
    
    // List tools from this server
    const serverTools = Object.entries(manifest.tools)
      .filter(([toolId, tool]) => tool.server === serverKey)
      .map(([toolId, tool]) => ({ toolId, tool }));
    
    serverTools.forEach(({ toolId, tool }) => {
      promptText += `### ${toolId}\n`;
      promptText += `Tool Name: ${tool.name}\n`;
      promptText += `${tool.description || 'No description'}\n`;
      
      if (tool.inputSchema?.properties) {
        promptText += `**Parameters:**\n`;
        Object.entries(tool.inputSchema.properties).forEach(([paramName, paramSpec]) => {
          const required = tool.inputSchema.required?.includes(paramName) ? ' (required)' : '';
          const description = paramSpec.description || '';
          promptText += `- ${paramName}${required}: ${paramSpec.type} - ${description}\n`;
        });
      }
      
      promptText += '\n';
    });
    
    promptText += '\n';
  });
  
  // Append local tools
  try {
    const localToolsFile = await fs.readFile(LOCAL_TOOLS_PATH, 'utf8');
    const localToolsConfig = JSON.parse(localToolsFile);
    
    promptText += `## Local Meta-Tools\n`;
    promptText += `${localToolsConfig.description}\n\n`;
    
    Object.entries(localToolsConfig.tools).forEach(([toolId, tool]) => {
      promptText += `### ${toolId}\n`;
      promptText += `Tool Name: ${tool.name}\n`;
      promptText += `${tool.description}\n`;
      
      if (tool.inputSchema?.properties) {
        promptText += `**Parameters:**\n`;
        Object.entries(tool.inputSchema.properties).forEach(([paramName, paramSpec]) => {
          const required = tool.inputSchema.required?.includes(paramName) ? ' (required)' : '';
          const description = paramSpec.description || '';
          const enumValues = paramSpec.enum ? ` [Options: ${paramSpec.enum.join(', ')}]` : '';
          promptText += `- ${paramName}${required}: ${paramSpec.type} - ${description}${enumValues}\n`;
        });
      }
      
      promptText += '\n';
    });
  } catch (error) {
    console.warn('[MCP Tool Discovery] Could not load local tools, skipping');
  }
  
  await fs.writeFile(TOOLS_PROMPT_PATH, promptText);
}

/**
 * Load cached tools manifest
 */
async function loadToolsManifest() {
  try {
    const manifestFile = await fs.readFile(TOOLS_MANIFEST_PATH, 'utf8');
    return JSON.parse(manifestFile);
  } catch (error) {
    console.warn('[MCP] Tools manifest not found, run discovery first');
    return null;
  }
}

/**
 * Load tools formatted for prompts (now includes local tools in the file itself)
 */
async function loadToolsForPrompt() {
  try {
    return await fs.readFile(TOOLS_PROMPT_PATH, 'utf8');
  } catch (error) {
    console.warn('[MCP] Tools prompt file not found');
    return '';
  }
}

/**
 * Get tool definition by ID (checks both MCP and local tools)
 */
async function getToolDefinition(toolId) {
  // Check if it's a local tool
  if (toolId && toolId.startsWith('local.')) {
    try {
      const localToolsFile = await fs.readFile(LOCAL_TOOLS_PATH, 'utf8');
      const localToolsConfig = JSON.parse(localToolsFile);
      return localToolsConfig.tools[toolId] || null;
    } catch (error) {
      console.warn('[MCP] Failed to load local tool definition');
      return null;
    }
  }
  
  // Check MCP tools
  const manifest = await loadToolsManifest();
  return manifest?.tools[toolId] || null;
}

module.exports = {
  discoverTools,
  loadToolsManifest,
  loadToolsForPrompt,
  getToolDefinition
};

