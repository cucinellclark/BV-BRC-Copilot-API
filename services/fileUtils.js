// services/fileUtils.js

/**
 * Utility functions for file data type detection and summarization
 */

// Configuration
const SAMPLE_RECORD_MAX_CHARS = 500;  // Maximum characters for sample record display

/**
 * Normalize tool result - handles various API response formats
 * Returns a standardized structure that all other functions can use
 * 
 * @param {any} result - Raw result from tool execution
 * @returns {Object} Normalized result with { data, metadata, dataType }
 */
function normalizeToolResult(result) {
  let data = result;
  let metadata = null;
  
  // NOTE: MCP wrapper unwrapping is now done in mcpExecutor.js before reaching this function
  // This function only handles extracting the data array from response objects
  
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    
    // Handle bvbrc-mcp-data format: extract results array OR tsv string OR fasta string
    if (result.source === 'bvbrc-mcp-data') {
      console.log('[FileUtils] Processing bvbrc-mcp-data response');
      // Preserve metadata for all BV-BRC data responses, including count-only
      // shapes that do not include results/tsv/fasta payload fields.
      metadata = { ...result };
      
      // Check for FASTA format first (for sequence data)
      if ('fasta' in result && typeof result.fasta === 'string') {
        console.log('[FileUtils] Extracting FASTA string from BV-BRC response');
        // Preserve ALL fields except the data string
        metadata = { ...result };
        delete metadata.fasta; // Remove the data string
        // Ensure totalCount is set for consistency
        if (result.count !== undefined || result.numFound !== undefined) {
          metadata.totalCount = result.count || result.numFound;
        }
        data = result.fasta;
      }
      // Check for TSV format (new default from MCP server)
      else if ('tsv' in result && typeof result.tsv === 'string') {
        console.log('[FileUtils] Extracting TSV string from BV-BRC response');
        // Preserve ALL fields except the data string
        metadata = { ...result };
        delete metadata.tsv; // Remove the data string
        // Ensure totalCount is set for consistency
        if (result.count !== undefined || result.numFound !== undefined) {
          metadata.totalCount = result.count || result.numFound;
        }
        data = result.tsv;
      }
      // Fallback to JSON format for backward compatibility
      else if ('results' in result && Array.isArray(result.results)) {
        console.log('[FileUtils] Extracting results array from BV-BRC response');
        // Preserve ALL fields except the data array
        metadata = { ...result };
        delete metadata.results; // Remove the data array
        // Ensure totalCount is set for consistency
        if (result.count !== undefined || result.numFound !== undefined) {
          metadata.totalCount = result.count || result.numFound;
        }
        data = result.results;
      }
    }
    // Handle workspace format: new structure has everything nested under "result"
    // Check for new format first: result.result.source === 'bvbrc-workspace'
    else if (result.result && result.result.source === 'bvbrc-workspace') {
      console.log('[FileUtils] Processing bvbrc-workspace response (new nested format)');
      const resultData = result.result;
      
      if ('items' in resultData && Array.isArray(resultData.items)) {
        console.log('[FileUtils] Extracting items array from workspace response');
        // Preserve ALL metadata fields from result.result
        metadata = { ...resultData };
        delete metadata.items; // Remove the data array
        // Ensure totalCount is set for consistency
        if (resultData.count !== undefined) {
          metadata.totalCount = resultData.count;
        }
        data = resultData.items;
      } else if ('metadata' in resultData) {
        console.log('[FileUtils] Extracting metadata object from workspace response');
        // Preserve ALL metadata fields from result.result
        metadata = { ...resultData };
        delete metadata.metadata; // Remove the metadata data object
        data = resultData.metadata;
      }
    }
    // Handle old workspace format for backward compatibility
    else if (result.source === 'bvbrc-workspace') {
      console.log('[FileUtils] Processing bvbrc-workspace response (legacy format)');
      
      if ('items' in result && Array.isArray(result.items)) {
        console.log('[FileUtils] Extracting items array from workspace response');
        // Preserve ALL fields except the data array
        metadata = { ...result };
        delete metadata.items; // Remove the data array
        // Ensure totalCount is set for consistency
        if (result.count !== undefined) {
          metadata.totalCount = result.count;
        }
        data = result.items;
      } else if ('result' in result && typeof result.result === 'object') {
        console.log('[FileUtils] Extracting result object from workspace response');
        // Preserve ALL fields except the result object
        metadata = { ...result };
        delete metadata.result; // Remove the data object
        data = result.result;
      }
    }
    // Add other source handlers here as needed
    // else if (result.source === 'bvbrc-rag') { ... }
    // else if (result.source === 'bvbrc-file-utilities') { ... }
  }
  
  // Detect data type of the normalized data
  const dataType = detectDataType(data);
  
  return {
    data,           // The actual data to work with
    metadata,       // API-specific metadata (or null)
    dataType        // Detected type of the data
  };
}

/**
 * Detect the data type of a result object
 */
function detectDataType(data) {
  if (data === null || data === undefined) {
    return 'null';
  }
  
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return 'empty_array';
    }
    // Check if it's an array of objects (common for query results)
    if (typeof data[0] === 'object' && data[0] !== null) {
      return 'json_array';
    }
    return 'array';
  }
  
  if (typeof data === 'object') {
    return 'json_object';
  }
  
  if (typeof data === 'string') {
    // Check if it looks like FASTA (starts with > and contains newlines)
    if (data.trim().startsWith('>') && data.includes('\n')) {
      return 'fasta';
    }
    // Check if it looks like CSV
    if (data.includes(',') && data.includes('\n')) {
      const lines = data.split('\n');
      if (lines.length > 1 && lines[0].includes(',')) {
        return 'csv';
      }
    }
    // Check if it looks like TSV
    if (data.includes('\t') && data.includes('\n')) {
      return 'tsv';
    }
    return 'text';
  }
  
  return typeof data;
}

/**
 * Count records in data based on type
 */
function countRecords(data, dataType) {
  switch (dataType) {
    case 'json_array':
    case 'array':
      return Array.isArray(data) ? data.length : 0;
    
    case 'fasta':
      if (typeof data === 'string') {
        // Count sequences by counting '>' characters at the start of lines
        const lines = data.split('\n');
        return lines.filter(line => line.trim().startsWith('>')).length;
      }
      return 0;
    
    case 'csv':
    case 'tsv':
    case 'text':
      if (typeof data === 'string') {
        const lines = data.split('\n').filter(line => line.trim().length > 0);
        // Subtract 1 for header if it's CSV/TSV
        return dataType === 'text' ? lines.length : Math.max(0, lines.length - 1);
      }
      return 0;
    
    case 'json_object':
      return Object.keys(data).length;
    
    default:
      return 0;
  }
}

/**
 * Extract field names from data
 */
function extractFields(data, dataType) {
  switch (dataType) {
    case 'json_array':
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
        return Object.keys(data[0]);
      }
      return [];
    
    case 'json_object':
      if (typeof data === 'object' && data !== null) {
        return Object.keys(data);
      }
      return [];
    
    case 'fasta':
      // FASTA files have sequence IDs and sequences
      return ['sequence_id', 'sequence'];
    
    case 'csv':
    case 'tsv':
      if (typeof data === 'string') {
        const firstLine = data.split('\n')[0];
        const delimiter = dataType === 'csv' ? ',' : '\t';
        return firstLine.split(delimiter).map(field => field.trim());
      }
      return [];
    
    default:
      return [];
  }
}

/**
 * Get a sample record from the data
 * Limits sample to reasonable character count to avoid bloating prompts
 * 
 * @param {any} data - The data to sample from
 * @param {string} dataType - The type of data (json_array, json_object, csv, etc.)
 * @param {number} maxChars - Maximum characters for the sample (default: SAMPLE_RECORD_MAX_CHARS)
 * @returns {any} Sample record, truncated if necessary
 */
function getSampleRecord(data, dataType, maxChars = SAMPLE_RECORD_MAX_CHARS) {
  let sample = null;
  
  switch (dataType) {
    case 'json_array':
      if (Array.isArray(data) && data.length > 0) {
        sample = data[0];
      }
      break;
    
    case 'json_object':
      sample = data;
      break;
    
    case 'fasta':
      if (typeof data === 'string') {
        // Extract the first sequence entry (header + sequence)
        const lines = data.split('\n');
        const firstHeaderIdx = lines.findIndex(line => line.trim().startsWith('>'));
        if (firstHeaderIdx !== -1) {
          const header = lines[firstHeaderIdx].substring(1).trim(); // Remove '>'
          // Find the next header or end of file
          let sequenceLines = [];
          for (let i = firstHeaderIdx + 1; i < lines.length; i++) {
            if (lines[i].trim().startsWith('>')) {
              break;
            }
            if (lines[i].trim().length > 0) {
              sequenceLines.push(lines[i].trim());
            }
          }
          const sequence = sequenceLines.join('');
          sample = {
            sequence_id: header,
            sequence: sequence.length > 100 ? sequence.substring(0, 100) + '...' : sequence,
            sequence_length: sequence.length
          };
        }
      }
      break;
    
    case 'csv':
    case 'tsv':
      if (typeof data === 'string') {
        const lines = data.split('\n').filter(line => line.trim().length > 0);
        if (lines.length > 1) {
          const delimiter = dataType === 'csv' ? ',' : '\t';
          const headers = lines[0].split(delimiter).map(h => h.trim());
          const values = lines[1].split(delimiter).map(v => v.trim());
          const record = {};
          headers.forEach((header, idx) => {
            record[header] = values[idx] || null;
          });
          sample = record;
        }
      }
      break;
    
    case 'text':
      if (typeof data === 'string') {
        // For text, return up to maxChars characters
        sample = data.substring(0, maxChars);
        if (data.length > maxChars) {
          sample += '...';
        }
        return sample;
      }
      break;
    
    default:
      return null;
  }
  
  // Truncate sample if it's too large (for JSON types)
  // Return as a formatted JSON string for better display
  if (sample !== null && (dataType === 'json_array' || dataType === 'json_object' || dataType === 'csv' || dataType === 'tsv' || dataType === 'fasta')) {
    const sampleStr = JSON.stringify(sample, null, 2);
    if (sampleStr.length > maxChars) {
      // Create a truncated version by keeping only some fields
      if (typeof sample === 'object' && sample !== null) {
        const keys = Object.keys(sample);
        const truncatedSample = {};
        let currentLength = 2; // Account for {}
        
        for (const key of keys) {
          let value = sample[key];
          
          // Truncate individual field values if they're too long
          if (typeof value === 'string' && value.length > 100) {
            value = value.substring(0, 97) + '...';
          } else if (Array.isArray(value)) {
            const arrStr = JSON.stringify(value);
            if (arrStr.length > 100) {
              // Show first few items instead of just count
              const preview = value.slice(0, 2);
              value = `[${preview.map(v => JSON.stringify(v)).join(', ')}${value.length > 2 ? `, ... +${value.length - 2} more` : ''}]`;
            }
          } else if (typeof value === 'object' && value !== null) {
            const objStr = JSON.stringify(value);
            if (objStr.length > 100) {
              // Show first few keys instead of just [Object]
              const objKeys = Object.keys(value);
              value = `{${objKeys.slice(0, 2).join(', ')}${objKeys.length > 2 ? `, ... +${objKeys.length - 2} more` : ''}}`;
            }
          }
          
          const valueStr = JSON.stringify(value);
          const entryLength = key.length + valueStr.length + 4; // "key": value,
          
          if (currentLength + entryLength > maxChars - 20) { // Leave room for "..." indicator
            truncatedSample['...'] = `${keys.length - Object.keys(truncatedSample).length} more fields`;
            break;
          }
          
          truncatedSample[key] = value;
          currentLength += entryLength;
        }
        
        // Return as formatted JSON string
        return JSON.stringify(truncatedSample, null, 2);
      }
    }
    
    // Return as formatted JSON string (not too large)
    return sampleStr;
  }
  
  return sample;
}

/**
 * Create a comprehensive summary from normalized data
 * 
 * @param {Object} normalizedResult - Result from normalizeToolResult()
 * @param {number} originalSize - Original size in bytes before normalization
 * @returns {Object} Summary with data type, counts, fields, samples, etc.
 */
function createSummary(normalizedResult, originalSize) {
  const { data, metadata, dataType } = normalizedResult;
  
  const recordCount = countRecords(data, dataType);
  const fields = extractFields(data, dataType);
  const sampleRecord = getSampleRecord(data, dataType);
  
  const summary = {
    dataType,
    size: originalSize,
    recordCount,
    fields,
    sampleRecord
  };
  
  // Add API-specific metadata if present
  if (metadata) {
    summary.sourceMetadata = metadata;
  }
  
  // Add type-specific metadata
  if (dataType === 'json_array' || dataType === 'array') {
    summary.isArray = true;
  } else if (dataType === 'json_object') {
    summary.isObject = true;
  } else if (dataType === 'csv' || dataType === 'tsv') {
    summary.isTabular = true;
    summary.delimiter = dataType === 'csv' ? ',' : '\t';
  } else if (dataType === 'fasta') {
    summary.isFasta = true;
    summary.fileFormat = 'FASTA';
  }
  
  return summary;
}

/**
 * Format size in human-readable format
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Truncate data for inline display (used when result is just slightly over threshold)
 */
function truncateForDisplay(data, maxLength = 500) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  
  if (str.length <= maxLength) {
    return str;
  }
  
  return str.substring(0, maxLength) + '... [truncated]';
}

module.exports = {
  normalizeToolResult,
  detectDataType,
  countRecords,
  extractFields,
  getSampleRecord,
  createSummary,
  formatSize,
  truncateForDisplay
};

