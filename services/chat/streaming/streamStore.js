const { connectToDatabase } = require('../../database');
const { LLMServiceError } = require('../../llm/llmServices');

const TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Set data in the stream store with TTL
 * @param {string} streamId - The stream ID
 * @param {any} data - The data to store
 * @returns {Promise<Object>} Insert result
 */
async function set(streamId, data) {
  try {
    console.log('setting streamId: ', streamId);
    
    // Clean up expired entries before setting new one
    await cleanup();
    
    const db = await connectToDatabase();
    const streamCollection = db.collection('streamStore');
    
    // Use upsert to replace existing entry or create new one
    const result = await streamCollection.replaceOne(
      { streamId },
      {
        streamId,
        data,
        timestamp: new Date(),
        expiresAt: new Date(Date.now() + TTL_MS)
      },
      { upsert: true }
    );
    
    console.log('stream data stored in database for streamId:', streamId);
    return result;
  } catch (error) {
    console.error(`Failed to set stream data for ${streamId}:`, error);
    throw new LLMServiceError('Failed to set stream data', error);
  }
}

/**
 * Get data from the stream store
 * @param {string} streamId - The stream ID
 * @returns {Promise<any|null>} The stored data or null if not found/expired
 */
async function get(streamId) {
  try {
    const db = await connectToDatabase();
    const streamCollection = db.collection('streamStore');
    
    const entry = await streamCollection.findOne({ streamId });
    
    if (!entry) {
      console.log('stream data not found for streamId:', streamId);
      return null;
    }
    
    const now = new Date();
    const diff = now.getTime() - entry.timestamp.getTime();
    
    console.log('diff:', diff, 'TTL_MS:', TTL_MS);
    
    // Check if entry has expired
    if (diff > TTL_MS || now > entry.expiresAt) {
      console.log('stream data expired for streamId:', streamId);
      // Remove expired entry
      await streamCollection.deleteOne({ streamId });
      return null;
    }
    
    console.log('stream data retrieved for streamId:', streamId);
    return entry.data;
  } catch (error) {
    console.error(`Failed to get stream data for ${streamId}:`, error);
    throw new LLMServiceError('Failed to get stream data', error);
  }
}

/**
 * Remove data from the stream store
 * @param {string} streamId - The stream ID
 * @returns {Promise<Object>} Delete result
 */
async function remove(streamId) {
  try {
    const db = await connectToDatabase();
    const streamCollection = db.collection('streamStore');
    
    const result = await streamCollection.deleteOne({ streamId });
    console.log('stream data removed for streamId:', streamId);
    return result;
  } catch (error) {
    console.error(`Failed to remove stream data for ${streamId}:`, error);
    throw new LLMServiceError('Failed to remove stream data', error);
  }
}

/**
 * Clean up expired entries from the stream store
 * @returns {Promise<Object>} Delete result
 */
async function cleanup() {
  try {
    const db = await connectToDatabase();
    const streamCollection = db.collection('streamStore');
    
    const now = new Date();
    
    // Remove entries that have expired based on timestamp or expiresAt
    const result = await streamCollection.deleteMany({
      $or: [
        { expiresAt: { $lt: now } },
        { timestamp: { $lt: new Date(now.getTime() - TTL_MS) } }
      ]
    });
    
    if (result.deletedCount > 0) {
      console.log(`Cleaned up ${result.deletedCount} expired stream entries`);
    }
    
    return result;
  } catch (error) {
    console.error('Failed to cleanup stream data:', error);
    // Don't throw error for cleanup failures to avoid disrupting main operations
  }
}

/**
 * Initialize the stream store collection with appropriate indexes
 * @returns {Promise<void>}
 */
async function initializeStreamStore() {
  try {
    const db = await connectToDatabase();
    const streamCollection = db.collection('streamStore');
    
    // Create TTL index on expiresAt field for automatic cleanup
    await streamCollection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 }
    );
    
    // Create index on streamId for faster lookups
    await streamCollection.createIndex({ streamId: 1 }, { unique: true });
    
    console.log('StreamStore collection initialized with indexes');
  } catch (error) {
    console.error('Failed to initialize stream store:', error);
    // Don't throw error if indexes already exist
  }
}

// Initialize the collection when module loads
initializeStreamStore().catch(console.error);

// Periodic cleanup - MongoDB TTL will handle most cleanup, but this ensures cleanup even if TTL fails
const interval = setInterval(cleanup, TTL_MS);
interval.unref();

module.exports = {
  set,
  get,
  remove,
  cleanup,
  initializeStreamStore
}; 