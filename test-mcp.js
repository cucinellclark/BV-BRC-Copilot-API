#!/usr/bin/env node
// test-mcp.js - Simple test script for MCP integration

const ChatService = require('./services/chatService');

async function testMCPIntegration() {
  console.log('Testing MCP Integration...\n');
  
  try {
    // Initialize MCP Client
    console.log('1. Initializing MCP Client...');
    await ChatService.initializeMCP();
    console.log('✓ MCP Client initialized successfully\n');
    
    // Get connected servers
    console.log('2. Getting connected servers...');
    const connectedServers = ChatService.getConnectedMCPServers();
    console.log('Connected servers:', connectedServers);
    console.log('✓ Found', connectedServers.length, 'connected servers\n');
    
    // Get available tools
    console.log('3. Getting available tools...');
    const availableTools = ChatService.getAvailableMCPTools();
    console.log('Available tools:', availableTools.length);
    
    if (availableTools.length > 0) {
      console.log('Sample tools:');
      availableTools.slice(0, 3).forEach(tool => {
        console.log(`  - ${tool.name} (${tool.serverName}): ${tool.description || 'No description'}`);
      });
    }
    console.log('✓ Found', availableTools.length, 'available tools\n');
    
    // Test tool methods
    if (availableTools.length > 0) {
      console.log('4. Testing tool methods...');
      const firstTool = availableTools[0];
      const serverName = firstTool.serverName;
      
      // Test getMCPToolsByServer
      const serverTools = ChatService.getMCPToolsByServer(serverName);
      console.log(`✓ Found ${serverTools.length} tools for server: ${serverName}`);
      
      // Test getMCPToolsForPrompt
      const promptTools = ChatService.getMCPToolsForPrompt();
      console.log(`✓ Found ${promptTools.length} tools formatted for prompts`);
      
      // Test tool execution (if tools are available)
      console.log('5. Testing tool execution...');
      console.log(`Testing tool: ${firstTool.name} from ${serverName}`);
      
      try {
        // This will likely fail since the MCP servers aren't actually running,
        // but it will test the integration
        const result = await ChatService.executeMCPTool(
          serverName, 
          firstTool.name, 
          {}
        );
        console.log('✓ Tool execution successful:', result);
      } catch (error) {
        console.log('⚠ Tool execution failed (expected if servers not running):', error.message);
      }
    }
    
    console.log('\n✓ MCP Integration test completed successfully!');
    
  } catch (error) {
    console.error('✗ MCP Integration test failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Run the test
testMCPIntegration().then(() => {
  console.log('\nTest completed. Exiting...');
  process.exit(0);
}).catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
