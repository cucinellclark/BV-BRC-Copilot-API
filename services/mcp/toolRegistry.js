// services/mcp/toolRegistry.js

class ToolRegistry {
  constructor() {
    this.tools = new Map(); // serverName -> tools[]
    this.toolIndex = new Map(); // toolName -> { serverName, toolDefinition }
  }

  registerTools(serverName, tools) {
    if (!Array.isArray(tools)) {
      console.warn(`Invalid tools array for server ${serverName}`);
      return;
    }

    this.tools.set(serverName, tools);
    
    // Index tools by name for quick lookup
    tools.forEach(tool => {
      if (tool.name) {
        this.toolIndex.set(tool.name, {
          serverName,
          toolDefinition: tool
        });
      }
    });

    console.log(`Registered ${tools.length} tools for server: ${serverName}`);
  }

  getToolsByServer(serverName) {
    return this.tools.get(serverName) || [];
  }

  getAllTools() {
    const allTools = [];
    for (const [serverName, tools] of this.tools) {
      allTools.push(...tools.map(tool => ({
        ...tool,
        serverName
      })));
    }
    return allTools;
  }

  getToolByName(toolName) {
    return this.toolIndex.get(toolName) || null;
  }

  getAvailableToolNames() {
    return Array.from(this.toolIndex.keys());
  }

  getServerNames() {
    return Array.from(this.tools.keys());
  }

  clear() {
    this.tools.clear();
    this.toolIndex.clear();
  }

  removeServer(serverName) {
    const tools = this.tools.get(serverName) || [];
    
    // Remove from tool index
    tools.forEach(tool => {
      if (tool.name) {
        this.toolIndex.delete(tool.name);
      }
    });

    this.tools.delete(serverName);
    console.log(`Removed tools for server: ${serverName}`);
  }

  getToolsForPrompt() {
    const tools = this.getAllTools();
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description || 'No description available',
      parameters: tool.inputSchema || {},
      server: tool.serverName
    }));
  }
}

module.exports = ToolRegistry;
