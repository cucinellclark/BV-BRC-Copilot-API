// services/logger.js

const fs = require('fs');
const path = require('path');
const util = require('util');

// Log levels
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Configuration
const LOG_DIR = path.join(__dirname, '..', 'logs');
const CONSOLE_LOG_LEVEL = LOG_LEVELS.DEBUG; // Log everything to console
const FILE_LOG_LEVEL = LOG_LEVELS.DEBUG; // Log everything to file

/**
 * Ensure the logs directory and session subdirectory exist
 */
function ensureLogDirectory(sessionId = null) {
  try {
    // Create main logs directory
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    
    // Create session subdirectory if sessionId provided
    if (sessionId) {
      const sessionDir = path.join(LOG_DIR, sessionId);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      return sessionDir;
    }
    
    return LOG_DIR;
  } catch (error) {
    console.error('Failed to create log directory:', error);
    return null;
  }
}

/**
 * Format a log message with timestamp and metadata
 */
function formatLogMessage(level, prefix, message, metadata = null) {
  const timestamp = new Date().toISOString();
  const levelStr = Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === level) || 'INFO';
  
  let formattedMessage = `[${timestamp}] [${levelStr}]`;
  
  if (prefix) {
    formattedMessage += ` [${prefix}]`;
  }
  
  formattedMessage += ` ${message}`;
  
  if (metadata) {
    if (typeof metadata === 'object') {
      formattedMessage += `\n${JSON.stringify(metadata, null, 2)}`;
    } else {
      formattedMessage += ` ${metadata}`;
    }
  }
  
  return formattedMessage;
}

/**
 * Write log to file
 */
function writeToFile(sessionId, filename, content, queryId = null) {
  try {
    let logDir = ensureLogDirectory(sessionId);
    if (!logDir) return;
    
    // If queryId is provided, create/use query subfolder
    if (queryId) {
      const queryDir = path.join(logDir, `query-${queryId}`);
      if (!fs.existsSync(queryDir)) {
        fs.mkdirSync(queryDir, { recursive: true });
      }
      logDir = queryDir;
    }
    
    const filePath = path.join(logDir, filename);
    const logEntry = `${content}\n`;
    
    fs.appendFileSync(filePath, logEntry, 'utf8');
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
}

/**
 * Logger class - provides session-aware logging
 */
class Logger {
  constructor(prefix = null, sessionId = null) {
    this.prefix = prefix;
    this.sessionId = sessionId;
    this.logBuffer = []; // Buffer for in-memory logs
    this.sequenceCounters = {
      prompt: 0,
      response: 0,
      tool: 0,
      iteration: 0
    };
    this.flowEvents = []; // Track flow for diagram
    this.currentQueryId = null; // Letter identifier for current query (A, B, C, etc.)
    
    // Auto-detect query counter from existing folders
    this.queryCounter = this._detectLastQueryIndex();
    
    // Create session directory if session ID provided
    if (sessionId) {
      ensureLogDirectory(sessionId);
    }
  }
  
  /**
   * Detect the last query index by checking existing query folders
   * Returns -1 if no queries exist yet, or the index of the last query
   */
  _detectLastQueryIndex() {
    if (!this.sessionId) return -1;
    
    try {
      const sessionDir = path.join(LOG_DIR, this.sessionId);
      if (!fs.existsSync(sessionDir)) return -1;
      
      // Find all query-* folders
      const files = fs.readdirSync(sessionDir);
      const queryFolders = files.filter(f => {
        const fullPath = path.join(sessionDir, f);
        return fs.statSync(fullPath).isDirectory() && f.startsWith('query-');
      });
      
      if (queryFolders.length === 0) return -1;
      
      // Extract letters and find the highest
      const letters = queryFolders
        .map(f => f.replace('query-', ''))
        .filter(l => l.length === 1 && l >= 'A' && l <= 'Z');
      
      if (letters.length === 0) return -1;
      
      // Get the highest letter and convert to index
      const highestLetter = letters.sort().pop();
      const highestIndex = highestLetter.charCodeAt(0) - 65; // A=0, B=1, etc.
      
      return highestIndex;
    } catch (error) {
      console.error('Failed to detect last query index:', error);
      return -1;
    }
  }
  
  /**
   * Set or update session ID
   */
  setSessionId(sessionId) {
    this.sessionId = sessionId;
    if (sessionId) {
      ensureLogDirectory(sessionId);
    }
  }
  
  /**
   * Start a new query/conversation turn
   * Call this when the user asks a new question in the same session
   */
  startNewQuery() {
    this.queryCounter++;
    // Convert number to letter: 0=A, 1=B, 2=C, etc.
    this.currentQueryId = String.fromCharCode(65 + this.queryCounter);
    
    // Reset sequence counters for this query
    this.sequenceCounters = {
      prompt: 0,
      response: 0,
      tool: 0,
      iteration: 0
    };
    
    // Create query subfolder
    if (this.sessionId) {
      const queryDir = path.join(LOG_DIR, this.sessionId, `query-${this.currentQueryId}`);
      if (!fs.existsSync(queryDir)) {
        fs.mkdirSync(queryDir, { recursive: true });
      }
    }
    
    // Console logging removed for query start
    // this.info(`Starting new query: ${this.currentQueryId}`, {
    //   queryCounter: this.queryCounter,
    //   queryId: this.currentQueryId,
    //   previousQueryCount: this.queryCounter
    // });
    
    return this.currentQueryId;
  }
  
  /**
   * Core logging method
   */
  log(level, message, metadata = null, options = {}) {
    const formattedMessage = formatLogMessage(level, this.prefix, message, metadata);
    
    // Add to in-memory buffer
    this.logBuffer.push({
      timestamp: new Date().toISOString(),
      level: Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === level),
      prefix: this.prefix,
      message,
      metadata
    });
    
    // Console output
    if (level >= CONSOLE_LOG_LEVEL) {
      if (level >= LOG_LEVELS.ERROR) {
        console.error(formattedMessage);
      } else if (level >= LOG_LEVELS.WARN) {
        console.warn(formattedMessage);
      } else {
        console.log(formattedMessage);
      }
    }
    
    // File output
    if (level >= FILE_LOG_LEVEL && this.sessionId) {
      const filename = options.filename || 'main.log';
      writeToFile(this.sessionId, filename, formattedMessage);
    }
  }
  
  /**
   * Convenience methods
   */
  debug(message, metadata = null, options = {}) {
    this.log(LOG_LEVELS.DEBUG, message, metadata, options);
  }
  
  info(message, metadata = null, options = {}) {
    this.log(LOG_LEVELS.INFO, message, metadata, options);
  }
  
  warn(message, metadata = null, options = {}) {
    this.log(LOG_LEVELS.WARN, message, metadata, options);
  }
  
  error(message, metadata = null, options = {}) {
    this.log(LOG_LEVELS.ERROR, message, metadata, options);
  }
  
  /**
   * Log LLM prompt (special case - always goes to separate numbered file)
   */
  logPrompt(promptName, promptContent, model = null, metadata = null) {
    const timestamp = new Date().toISOString();
    this.sequenceCounters.prompt++;
    const sequenceNum = String(this.sequenceCounters.prompt).padStart(3, '0');
    const queryId = this.currentQueryId;
    
    const promptLog = {
      timestamp,
      promptName,
      model,
      content: promptContent,
      metadata,
      sequence: this.sequenceCounters.prompt,
      queryId
    };
    
    // Console output (truncated) - removed query logging
    // this.info(`[Query ${queryId}] LLM Prompt #${sequenceNum}: ${promptName}`, { model, contentLength: promptContent.length });
    
    // File output (full content in numbered file)
    if (this.sessionId) {
      const formattedPromptLog = `
${'='.repeat(80)}
QUERY ${queryId} - PROMPT #${sequenceNum}
[${timestamp}] ${promptName}
Model: ${model || 'Not specified'}
${'='.repeat(80)}
${promptContent}
${'='.repeat(80)}
Metadata: ${metadata ? JSON.stringify(metadata, null, 2) : 'None'}
${'='.repeat(80)}
`;
      // Write to numbered file in query subfolder
      const filename = `prompt-${sequenceNum}.log`;
      writeToFile(this.sessionId, filename, formattedPromptLog, queryId);
      
      // Add to flow
      this.flowEvents.push({
        type: 'prompt',
        sequence: this.sequenceCounters.prompt,
        queryId,
        name: promptName,
        timestamp,
        model,
        file: `query-${queryId}/${filename}`
      });
      
      this.updateFlowDiagram();
    }
    
    return this.sequenceCounters.prompt;
  }
  
  /**
   * Log LLM response (special case - always goes to separate numbered file)
   */
  logResponse(promptName, response, model = null, metadata = null) {
    const timestamp = new Date().toISOString();
    this.sequenceCounters.response++;
    const sequenceNum = String(this.sequenceCounters.response).padStart(3, '0');
    const queryId = this.currentQueryId;
    
    const responseLog = {
      timestamp,
      promptName,
      model,
      response,
      metadata,
      sequence: this.sequenceCounters.response,
      queryId
    };
    
    // Console output (truncated) - removed query logging
    // this.info(`[Query ${queryId}] LLM Response #${sequenceNum}: ${promptName}`, { model, responseLength: response.length });
    
    // File output (full content in numbered file)
    if (this.sessionId) {
      const formattedResponseLog = `
${'='.repeat(80)}
QUERY ${queryId} - RESPONSE #${sequenceNum}
[${timestamp}] ${promptName}
Model: ${model || 'Not specified'}
${'='.repeat(80)}
${response}
${'='.repeat(80)}
Metadata: ${metadata ? JSON.stringify(metadata, null, 2) : 'None'}
${'='.repeat(80)}
`;
      // Write to numbered file in query subfolder
      const filename = `response-${sequenceNum}.log`;
      writeToFile(this.sessionId, filename, formattedResponseLog, queryId);
      
      // Add to flow
      this.flowEvents.push({
        type: 'response',
        sequence: this.sequenceCounters.response,
        queryId,
        name: promptName,
        timestamp,
        model,
        file: `query-${queryId}/${filename}`,
        length: response.length
      });
      
      this.updateFlowDiagram();
    }
    
    return this.sequenceCounters.response;
  }
  
  /**
   * Log tool execution (for agent tools) - goes to numbered file
   */
  logToolExecution(toolName, parameters, result, status = 'success', error = null) {
    const timestamp = new Date().toISOString();
    this.sequenceCounters.tool++;
    const sequenceNum = String(this.sequenceCounters.tool).padStart(3, '0');
    const queryId = this.currentQueryId;
    
    const toolLog = {
      timestamp,
      toolName,
      parameters,
      status,
      error: error ? error.message : null,
      result: result,
      sequence: this.sequenceCounters.tool,
      queryId
    };
    
    // Console output - removed query logging
    // this.info(`[Query ${queryId}] Tool Execution #${sequenceNum}: ${toolName} [${status}]`, { 
    //   parametersCount: Object.keys(parameters || {}).length,
    //   hasError: !!error
    // });
    
    // File output (full content in numbered file)
    if (this.sessionId) {
      const formattedToolLog = `
${'='.repeat(80)}
QUERY ${queryId} - TOOL EXECUTION #${sequenceNum}
[${timestamp}] ${toolName}
Status: ${status}
${'='.repeat(80)}
Parameters:
${JSON.stringify(parameters, null, 2)}
${'-'.repeat(80)}
Result:
${typeof result === 'object' ? JSON.stringify(result, null, 2) : result}
${error ? `${'-'.repeat(80)}\nError:\n${error.message}\n${error.stack || ''}` : ''}
${'='.repeat(80)}
`;
      // Write to numbered file in query subfolder
      const filename = `tool-${sequenceNum}.log`;
      writeToFile(this.sessionId, filename, formattedToolLog, queryId);
      
      // Add to flow
      this.flowEvents.push({
        type: 'tool',
        sequence: this.sequenceCounters.tool,
        queryId,
        name: toolName,
        timestamp,
        status,
        file: `query-${queryId}/${filename}`,
        hasError: !!error
      });
      
      this.updateFlowDiagram();
    }
    
    return this.sequenceCounters.tool;
  }
  
  /**
   * Log agent iteration summary - goes to numbered file
   */
  logAgentIteration(iteration, action, reasoning, parameters, result, status) {
    const timestamp = new Date().toISOString();
    this.sequenceCounters.iteration++;
    const sequenceNum = String(this.sequenceCounters.iteration).padStart(3, '0');
    const queryId = this.currentQueryId;
    
    const iterationLog = {
      timestamp,
      iteration,
      action,
      reasoning,
      parameters,
      status,
      result,
      sequence: this.sequenceCounters.iteration,
      queryId
    };
    
    // Console output - removed query logging
    // this.info(`[Query ${queryId}] Agent Iteration #${sequenceNum} (${iteration}): ${action}`, { reasoning, status });
    
    // File output (full content in numbered file)
    if (this.sessionId) {
      const formattedIterationLog = `
${'='.repeat(80)}
QUERY ${queryId} - ITERATION #${sequenceNum}
[${timestamp}] Agent Iteration ${iteration}
Action: ${action}
Status: ${status}
${'='.repeat(80)}
Reasoning:
${reasoning}
${'-'.repeat(80)}
Parameters:
${JSON.stringify(parameters, null, 2)}
${'-'.repeat(80)}
Result:
${typeof result === 'object' ? JSON.stringify(result, null, 2) : result}
${'='.repeat(80)}
`;
      // Write to numbered file in query subfolder
      const filename = `iteration-${sequenceNum}.log`;
      writeToFile(this.sessionId, filename, formattedIterationLog, queryId);
      
      // Add to flow
      this.flowEvents.push({
        type: 'iteration',
        sequence: this.sequenceCounters.iteration,
        queryId,
        iteration,
        action,
        reasoning: reasoning.substring(0, 100) + (reasoning.length > 100 ? '...' : ''),
        timestamp,
        status,
        file: `query-${queryId}/${filename}`
      });
      
      this.updateFlowDiagram();
    }
    
    return this.sequenceCounters.iteration;
  }
  
  /**
   * Update the flow diagram file - creates both a master FLOW.txt and per-query FLOW-X.txt files
   */
  updateFlowDiagram() {
    if (!this.sessionId) return;
    
    // Get unique query IDs
    const allQueryIds = [...new Set(this.flowEvents.map(e => e.queryId))];
    
    // Create master flow with all queries
    this.createMasterFlow();
    
    // Create individual flow for each query
    allQueryIds.forEach(queryId => {
      this.createQueryFlow(queryId);
    });
  }
  
  /**
   * Create master flow diagram with all queries
   */
  createMasterFlow() {
    const lines = [];
    lines.push('=' .repeat(100));
    lines.push('AGENT EXECUTION FLOW DIAGRAM - ALL QUERIES');
    lines.push('=' .repeat(100));
    lines.push('');
    lines.push(`Session ID: ${this.sessionId}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Total Events: ${this.flowEvents.length}`);
    
    // Count queries
    const queryIds = [...new Set(this.flowEvents.map(e => e.queryId))];
    lines.push(`Total Queries: ${queryIds.length} (${queryIds.join(', ')})`);
    lines.push('');
    lines.push('=' .repeat(100));
    lines.push('');
    
    // Group events by query, then by iteration
    let currentQuery = null;
    let currentIteration = 0;
    
    for (let i = 0; i < this.flowEvents.length; i++) {
      const event = this.flowEvents[i];
      const isLast = i === this.flowEvents.length - 1;
      
      // Check if this starts a new query
      if (event.queryId !== currentQuery) {
        currentQuery = event.queryId;
        lines.push('');
        lines.push('█'.repeat(100));
        lines.push(`█ QUERY ${currentQuery}`.padEnd(99) + '█');
        lines.push('█'.repeat(100));
        lines.push('');
        currentIteration = 0; // Reset iteration counter for new query
      }
      
      // Check if this starts a new iteration
      if (event.type === 'iteration' && event.iteration !== currentIteration) {
        currentIteration = event.iteration;
        lines.push('');
        lines.push('╔' + '═'.repeat(98) + '╗');
        lines.push(`║ ITERATION ${currentIteration}`.padEnd(99) + '║');
        lines.push('╚' + '═'.repeat(98) + '╝');
        lines.push('');
      }
      
      // Format based on type
      switch (event.type) {
        case 'prompt':
          lines.push(`  ┌─ PROMPT #${String(event.sequence).padStart(3, '0')}: ${event.name}`);
          lines.push(`  │  File: ${event.file}`);
          lines.push(`  │  Model: ${event.model || 'N/A'}`);
          lines.push(`  │  Time: ${new Date(event.timestamp).toLocaleTimeString()}`);
          if (!isLast) lines.push('  │');
          lines.push('  ↓');
          break;
          
        case 'response':
          lines.push(`  └─ RESPONSE #${String(event.sequence).padStart(3, '0')}: ${event.name}`);
          lines.push(`     File: ${event.file}`);
          lines.push(`     Model: ${event.model || 'N/A'}`);
          lines.push(`     Length: ${event.length} chars`);
          lines.push(`     Time: ${new Date(event.timestamp).toLocaleTimeString()}`);
          if (!isLast) {
            lines.push('');
            lines.push('  ↓');
            lines.push('');
          }
          break;
          
        case 'tool':
          const statusSymbol = event.status === 'success' ? '✓' : '✗';
          lines.push(`  ├─ TOOL #${String(event.sequence).padStart(3, '0')} [${statusSymbol}]: ${event.name}`);
          lines.push(`  │  File: ${event.file}`);
          lines.push(`  │  Status: ${event.status.toUpperCase()}`);
          lines.push(`  │  Time: ${new Date(event.timestamp).toLocaleTimeString()}`);
          if (!isLast) lines.push('  │');
          lines.push('  ↓');
          break;
          
        case 'iteration':
          lines.push(`  ┌─ ITERATION #${String(event.sequence).padStart(3, '0')} (Agent Iteration ${event.iteration})`);
          lines.push(`  │  File: ${event.file}`);
          lines.push(`  │  Action: ${event.action}`);
          lines.push(`  │  Status: ${event.status}`);
          lines.push(`  │  Reasoning: ${event.reasoning}`);
          lines.push(`  │  Time: ${new Date(event.timestamp).toLocaleTimeString()}`);
          if (!isLast) lines.push('  │');
          lines.push('  ↓');
          break;
      }
      
      lines.push('');
    }
    
    lines.push('=' .repeat(100));
    lines.push('END OF FLOW - ALL QUERIES');
    lines.push('=' .repeat(100));
    lines.push('');
    
    // Summary statistics
    const masterQueryIds = [...new Set(this.flowEvents.map(e => e.queryId))];
    const promptCount = this.flowEvents.filter(e => e.type === 'prompt').length;
    const responseCount = this.flowEvents.filter(e => e.type === 'response').length;
    const toolCount = this.flowEvents.filter(e => e.type === 'tool').length;
    const iterationCount = this.flowEvents.filter(e => e.type === 'iteration').length;
    const successfulTools = this.flowEvents.filter(e => e.type === 'tool' && e.status === 'success').length;
    const failedTools = this.flowEvents.filter(e => e.type === 'tool' && e.status === 'failed').length;
    
    lines.push('OVERALL SUMMARY:');
    lines.push(`  Total Queries: ${masterQueryIds.length} (${masterQueryIds.join(', ')})`);
    lines.push(`  Total Prompts: ${promptCount}`);
    lines.push(`  Total Responses: ${responseCount}`);
    lines.push(`  Total Tools: ${toolCount} (${successfulTools} successful, ${failedTools} failed)`);
    lines.push(`  Total Iterations: ${iterationCount}`);
    lines.push('');
    
    // Per-query breakdown
    lines.push('PER-QUERY BREAKDOWN:');
    masterQueryIds.forEach(queryId => {
      const queryEvents = this.flowEvents.filter(e => e.queryId === queryId);
      const qPrompts = queryEvents.filter(e => e.type === 'prompt').length;
      const qResponses = queryEvents.filter(e => e.type === 'response').length;
      const qTools = queryEvents.filter(e => e.type === 'tool').length;
      const qIterations = queryEvents.filter(e => e.type === 'iteration').length;
      lines.push(`  Query ${queryId}: ${qPrompts} prompts, ${qResponses} responses, ${qTools} tools, ${qIterations} iterations`);
      lines.push(`           (See FLOW-${queryId}.txt for detailed flow)`);
    });
    lines.push('');
    
    // Write the complete master flow diagram
    const flowContent = lines.join('\n');
    const logDir = ensureLogDirectory(this.sessionId);
    if (logDir) {
      const filePath = path.join(logDir, 'FLOW.txt');
      fs.writeFileSync(filePath, flowContent, 'utf8');
    }
  }
  
  /**
   * Create individual flow diagram for a specific query
   */
  createQueryFlow(queryId) {
    const queryEvents = this.flowEvents.filter(e => e.queryId === queryId);
    if (queryEvents.length === 0) return;
    
    const lines = [];
    lines.push('=' .repeat(100));
    lines.push(`AGENT EXECUTION FLOW DIAGRAM - QUERY ${queryId}`);
    lines.push('=' .repeat(100));
    lines.push('');
    lines.push(`Session ID: ${this.sessionId}`);
    lines.push(`Query ID: ${queryId}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Total Events: ${queryEvents.length}`);
    lines.push('');
    lines.push('=' .repeat(100));
    lines.push('');
    
    // Process events for this query
    let currentIteration = 0;
    
    for (let i = 0; i < queryEvents.length; i++) {
      const event = queryEvents[i];
      const isLast = i === queryEvents.length - 1;
      
      // Check if this starts a new iteration
      if (event.type === 'iteration' && event.iteration !== currentIteration) {
        currentIteration = event.iteration;
        lines.push('');
        lines.push('╔' + '═'.repeat(98) + '╗');
        lines.push(`║ ITERATION ${currentIteration}`.padEnd(99) + '║');
        lines.push('╚' + '═'.repeat(98) + '╝');
        lines.push('');
      }
      
      // Format based on type (same as before)
      switch (event.type) {
        case 'prompt':
          lines.push(`  ┌─ PROMPT #${String(event.sequence).padStart(3, '0')}: ${event.name}`);
          lines.push(`  │  File: ${event.file}`);
          lines.push(`  │  Model: ${event.model || 'N/A'}`);
          lines.push(`  │  Time: ${new Date(event.timestamp).toLocaleTimeString()}`);
          if (!isLast) lines.push('  │');
          lines.push('  ↓');
          break;
          
        case 'response':
          lines.push(`  └─ RESPONSE #${String(event.sequence).padStart(3, '0')}: ${event.name}`);
          lines.push(`     File: ${event.file}`);
          lines.push(`     Model: ${event.model || 'N/A'}`);
          lines.push(`     Length: ${event.length} chars`);
          lines.push(`     Time: ${new Date(event.timestamp).toLocaleTimeString()}`);
          if (!isLast) {
            lines.push('');
            lines.push('  ↓');
            lines.push('');
          }
          break;
          
        case 'tool':
          const statusSymbol = event.status === 'success' ? '✓' : '✗';
          lines.push(`  ├─ TOOL #${String(event.sequence).padStart(3, '0')} [${statusSymbol}]: ${event.name}`);
          lines.push(`  │  File: ${event.file}`);
          lines.push(`  │  Status: ${event.status.toUpperCase()}`);
          lines.push(`  │  Time: ${new Date(event.timestamp).toLocaleTimeString()}`);
          if (!isLast) lines.push('  │');
          lines.push('  ↓');
          break;
          
        case 'iteration':
          lines.push(`  ┌─ ITERATION #${String(event.sequence).padStart(3, '0')} (Agent Iteration ${event.iteration})`);
          lines.push(`  │  File: ${event.file}`);
          lines.push(`  │  Action: ${event.action}`);
          lines.push(`  │  Status: ${event.status}`);
          lines.push(`  │  Reasoning: ${event.reasoning}`);
          lines.push(`  │  Time: ${new Date(event.timestamp).toLocaleTimeString()}`);
          if (!isLast) lines.push('  │');
          lines.push('  ↓');
          break;
      }
      
      lines.push('');
    }
    
    lines.push('=' .repeat(100));
    lines.push(`END OF FLOW - QUERY ${queryId}`);
    lines.push('=' .repeat(100));
    lines.push('');
    
    // Summary for this query
    const qPrompts = queryEvents.filter(e => e.type === 'prompt').length;
    const qResponses = queryEvents.filter(e => e.type === 'response').length;
    const qTools = queryEvents.filter(e => e.type === 'tool').length;
    const qIterations = queryEvents.filter(e => e.type === 'iteration').length;
    const qSuccessTools = queryEvents.filter(e => e.type === 'tool' && e.status === 'success').length;
    const qFailedTools = queryEvents.filter(e => e.type === 'tool' && e.status === 'failed').length;
    
    lines.push(`QUERY ${queryId} SUMMARY:`);
    lines.push(`  Prompts: ${qPrompts}`);
    lines.push(`  Responses: ${qResponses}`);
    lines.push(`  Tools: ${qTools} (${qSuccessTools} successful, ${qFailedTools} failed)`);
    lines.push(`  Iterations: ${qIterations}`);
    lines.push('');
    
    // Write the query-specific flow diagram
    const flowContent = lines.join('\n');
    const logDir = ensureLogDirectory(this.sessionId);
    if (logDir) {
      const filePath = path.join(logDir, `FLOW-${queryId}.txt`);
      fs.writeFileSync(filePath, flowContent, 'utf8');
    }
  }
  
  /**
   * Get all buffered logs
   */
  getLogBuffer() {
    return [...this.logBuffer];
  }
  
  /**
   * Clear log buffer
   */
  clearLogBuffer() {
    this.logBuffer = [];
  }
  
  /**
   * Create a child logger with a new prefix but same session
   * Child loggers share sequence counters, flow events, and query ID with parent
   */
  child(prefix) {
    const childLogger = new Logger(prefix, this.sessionId);
    // Share state with parent
    childLogger.sequenceCounters = this.sequenceCounters;
    childLogger.flowEvents = this.flowEvents;
    childLogger.queryCounter = this.queryCounter;
    childLogger.currentQueryId = this.currentQueryId;
    return childLogger;
  }
}

/**
 * Create a global logger instance
 */
function createLogger(prefix = null, sessionId = null) {
  return new Logger(prefix, sessionId);
}

/**
 * Create a session-specific log summary
 */
function createSessionSummary(sessionId) {
  try {
    const sessionDir = path.join(LOG_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) {
      return null;
    }
    
    const files = fs.readdirSync(sessionDir);
    const summary = {
      sessionId,
      logFiles: [],
      totalSize: 0,
      createdAt: null,
      lastModified: null
    };
    
    files.forEach(file => {
      const filePath = path.join(sessionDir, file);
      const stats = fs.statSync(filePath);
      
      summary.logFiles.push({
        name: file,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime
      });
      
      summary.totalSize += stats.size;
      
      if (!summary.createdAt || stats.birthtime < summary.createdAt) {
        summary.createdAt = stats.birthtime;
      }
      
      if (!summary.lastModified || stats.mtime > summary.lastModified) {
        summary.lastModified = stats.mtime;
      }
    });
    
    return summary;
  } catch (error) {
    console.error('Failed to create session summary:', error);
    return null;
  }
}

/**
 * Get logs for a specific session
 */
function getSessionLogs(sessionId, filename = 'main.log') {
  try {
    const filePath = path.join(LOG_DIR, sessionId, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    return null;
  } catch (error) {
    console.error('Failed to read session logs:', error);
    return null;
  }
}

// Export
module.exports = {
  Logger,
  createLogger,
  LOG_LEVELS,
  ensureLogDirectory,
  createSessionSummary,
  getSessionLogs
};

