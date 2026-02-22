// database.js

const { MongoClient } = require('mongodb');
const config = require('./utilities/mongodb_config.json'); // Load from utilities directory

// MongoDB setup with connection pooling
const mongoUri = config['mongoDBUrl'];
const connectionOptions = config['connectionOptions'];

const mongoClient = new MongoClient(mongoUri, connectionOptions);

// Track connection state
let isConnecting = false;
let isConnected = false;
let connectionError = null;

/**
 * Connect to MongoDB with proper connection pooling
 * @returns {Object} MongoDB database instance
 */
async function connectToDatabase() {
    // Return existing connection if already connected
    if (isConnected) {
        return mongoClient.db(config.database);
    }

    // Wait if connection is in progress
    if (isConnecting) {
        // Wait for connection to complete (max 10 seconds)
        for (let i = 0; i < 100; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (isConnected) {
                return mongoClient.db(config.database);
            }
            if (connectionError) {
                throw connectionError;
            }
        }
        throw new Error('MongoDB connection timeout');
    }

    // Establish new connection
    isConnecting = true;
    try {
        await mongoClient.connect();
        isConnected = true;
        connectionError = null;
        
        console.log('[MongoDB] Connected successfully');
        console.log(`[MongoDB] Pool config: maxPoolSize=${connectionOptions.maxPoolSize}, minPoolSize=${connectionOptions.minPoolSize}`);

        // Set up event listeners for connection monitoring
        mongoClient.on('serverDescriptionChanged', (event) => {
            console.log('[MongoDB] Server description changed:', event.address);
        });

        mongoClient.on('topologyOpening', () => {
            console.log('[MongoDB] Topology opening');
        });

        mongoClient.on('topologyClosed', () => {
            console.log('[MongoDB] Topology closed');
            isConnected = false;
        });

        return mongoClient.db(config.database);
    } catch (error) {
        connectionError = error;
        console.error('[MongoDB] Connection failed:', error.message);
        throw error;
    } finally {
        isConnecting = false;
    }
}

/**
 * Connect to a specific MongoDB database name using shared pooled client.
 * @param {string} dbName - Target database name
 * @returns {Object} MongoDB database instance
 */
async function connectToNamedDatabase(dbName) {
    const normalizedName = (typeof dbName === 'string' && dbName.trim())
        ? dbName.trim()
        : config.database;

    // Ensure the shared client is connected.
    await connectToDatabase();
    return mongoClient.db(normalizedName);
}

/**
 * Connect to trace database (separate DB for run/step traces).
 * Falls back to main DB if traceDatabase is not configured.
 * @returns {Object} MongoDB database instance
 */
async function connectToTraceDatabase() {
    const traceDbName = config.traceDatabase || config.database;
    return connectToNamedDatabase(traceDbName);
}

/**
 * Check MongoDB connection health
 * @returns {Object} Health status and connection info
 */
async function checkConnectionHealth() {
    try {
        if (!isConnected) {
            return {
                healthy: false,
                connected: false,
                message: 'Not connected to MongoDB'
            };
        }

        // Ping the database
        const db = mongoClient.db(config.database);
        await db.admin().ping();

        return {
            healthy: true,
            connected: true,
            poolSize: connectionOptions.maxPoolSize,
            message: 'MongoDB connection healthy'
        };
    } catch (error) {
        return {
            healthy: false,
            connected: isConnected,
            error: error.message,
            message: 'MongoDB health check failed'
        };
    }
}

/**
 * Get connection pool statistics
 * @returns {Object} Connection pool stats
 */
function getPoolStats() {
    return {
        isConnected,
        isConnecting,
        hasError: !!connectionError,
        errorMessage: connectionError?.message || null,
        poolConfig: {
            maxPoolSize: connectionOptions.maxPoolSize,
            minPoolSize: connectionOptions.minPoolSize,
            maxIdleTimeMS: connectionOptions.maxIdleTimeMS,
            socketTimeoutMS: connectionOptions.socketTimeoutMS
        }
    };
}

/**
 * Graceful shutdown - close MongoDB connection
 */
async function closeConnection() {
    if (isConnected) {
        console.log('[MongoDB] Closing connection...');
        await mongoClient.close();
        isConnected = false;
        console.log('[MongoDB] Connection closed');
    }
}

/**
 * Delete session from database
 * @param {string} sessionId - The session ID to delete
 * @param {string} userId - The user ID associated with the session
 * @returns {Object} Result of the delete operation
 */
async function removeBySession(sessionId, userId) {
    if (!sessionId || !userId) {
        throw new Error('Both session ID and user ID are required to delete a session.');
    }

    // Connect to the database
    const db = await connectToDatabase();
    const sessionsCollection = db.collection(config.collections.chatSessions);

    // Delete session document
    const deleteResult = await sessionsCollection.deleteOne({
        sessionId,
        userId
    });

    // Log result of delete operation
    if (deleteResult.deletedCount === 1) {
        console.log(`[MongoDB] Session deleted: session_id=${sessionId}, user_id=${userId}`);
    } else {
        console.log(`[MongoDB] Session not found or unauthorized: session_id=${sessionId}, user_id=${userId}`);
    }

    return deleteResult;
}

// Graceful shutdown on process termination
process.on('SIGINT', async () => {
    await closeConnection();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await closeConnection();
    process.exit(0);
});

module.exports = { 
    connectToDatabase, 
    connectToNamedDatabase,
    connectToTraceDatabase,
    removeBySession,
    checkConnectionHealth,
    getPoolStats,
    closeConnection,
    getMongoClient: () => mongoClient
};
