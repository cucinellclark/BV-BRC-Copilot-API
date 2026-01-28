// routes/healthRoutes.js

const express = require('express');
const { checkConnectionHealth, getPoolStats } = require('../database');
const router = express.Router();

/**
 * Liveness probe - is the process alive?
 * Returns 200 if the process is running (no external dependencies checked)
 */
router.get('/live', (req, res) => {
    res.status(200).json({ 
        status: 'ok',
        service: 'BV-BRC Copilot API',
        timestamp: new Date().toISOString()
    });
});

/**
 * Readiness probe - can the service handle requests?
 * Checks MongoDB connectivity and connection pool
 */
router.get('/ready', async (req, res) => {
    const checks = {
        mongodb: null,
        timestamp: new Date().toISOString()
    };
    
    let isReady = true;
    
    // Check MongoDB connection and pool
    try {
        const mongoHealth = await checkConnectionHealth();
        const poolStats = getPoolStats();
        
        checks.mongodb = {
            status: mongoHealth.healthy ? 'healthy' : 'unhealthy',
            connected: mongoHealth.connected,
            message: mongoHealth.message,
            connectionPool: {
                configured: `${poolStats.poolConfig.maxPoolSize} max, ${poolStats.poolConfig.minPoolSize} min`,
                isConnected: poolStats.isConnected,
                hasError: poolStats.hasError
            }
        };
        
        if (!mongoHealth.healthy) {
            isReady = false;
        }
    } catch (error) {
        checks.mongodb = {
            status: 'error',
            connected: false,
            error: error.message
        };
        isReady = false;
    }
    
    const statusCode = isReady ? 200 : 503;
    res.status(statusCode).json({
        status: isReady ? 'ready' : 'not_ready',
        message: isReady ? 'Service ready (MongoDB connection pool active)' : 'Service not ready (MongoDB connection issues)',
        checks
    });
});

/**
 * Startup probe - has initialization completed?
 * Checks if MongoDB connection pool is established
 */
router.get('/startup', async (req, res) => {
    const mongoHealth = await checkConnectionHealth();
    const poolStats = getPoolStats();
    
    if (mongoHealth.healthy) {
        res.status(200).json({ 
            status: 'started',
            message: 'MongoDB connection pool initialized',
            mongodb: {
                connected: true,
                poolSize: poolStats.poolConfig.maxPoolSize
            },
            timestamp: new Date().toISOString()
        });
    } else {
        res.status(503).json({ 
            status: 'starting',
            message: 'Waiting for MongoDB connection pool to initialize',
            mongodb: {
                connected: poolStats.isConnected,
                error: poolStats.errorMessage
            },
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Detailed health information (for monitoring/debugging)
 * Includes comprehensive MongoDB connection pool statistics
 */
router.get('/status', async (req, res) => {
    const mongoHealth = await checkConnectionHealth();
    const poolStats = getPoolStats();
    
    res.status(200).json({
        service: 'BV-BRC Copilot API',
        version: '1.0.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        
        system: {
            nodeVersion: process.version,
            platform: process.platform,
            pid: process.pid,
            memory: {
                heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
                heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
                rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`
            },
            cpu: process.cpuUsage()
        },
        
        mongodb: {
            health: mongoHealth,
            connectionPool: poolStats
        }
    });
});

/**
 * MongoDB-specific health check
 * Detailed connection pool and database statistics
 */
router.get('/mongodb', async (req, res) => {
    const mongoHealth = await checkConnectionHealth();
    const poolStats = getPoolStats();
    
    const statusCode = mongoHealth.healthy ? 200 : 503;
    
    res.status(statusCode).json({
        status: mongoHealth.healthy ? 'healthy' : 'unhealthy',
        message: mongoHealth.message,
        
        connection: {
            connected: mongoHealth.connected,
            healthy: mongoHealth.healthy,
            isConnecting: poolStats.isConnecting,
            hasError: poolStats.hasError,
            errorMessage: poolStats.errorMessage
        },
        
        connectionPool: {
            maxPoolSize: poolStats.poolConfig.maxPoolSize,
            minPoolSize: poolStats.poolConfig.minPoolSize,
            maxIdleTimeMS: poolStats.poolConfig.maxIdleTimeMS,
            socketTimeoutMS: poolStats.poolConfig.socketTimeoutMS,
            details: `Configured for ${poolStats.poolConfig.maxPoolSize} max connections with ${poolStats.poolConfig.minPoolSize} warm connections per PM2 instance`
        },
        
        timestamp: new Date().toISOString()
    });
});

module.exports = router;

