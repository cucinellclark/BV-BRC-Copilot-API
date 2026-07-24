// routes/ragRoutes.js

const express = require('express');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const config = require('../config.json');

const router = express.Router();

const COCONUT_URL = config.coconut_url || 'http://coconut.cels.anl.gov:8000';

// CORS headers for all /rag routes
function ragCors(req, res, next) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    // The global cors middleware sets Access-Control-Allow-Credentials: true,
    // which is invalid when combined with Access-Control-Allow-Origin: *.
    // Browsers reject responses with both headers, causing status-0 network errors.
    res.removeHeader('Access-Control-Allow-Credentials');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
}

router.use(ragCors);

/**
 * POST /retrieve
 * Proxies retrieval requests to the Coconut RAG service.
 * Passes the request body through as-is (query, top_k, use_graph, etc.).
 */
router.post('/retrieve', requireAuth, async (req, res) => {
    try {
        const response = await axios.post(`${COCONUT_URL}/v1/retrieve`, req.body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });

        return res.status(response.status).json(response.data);
    } catch (error) {
        if (error.response) {
            // Coconut server responded with an error status
            return res.status(error.response.status).json({
                error: 'Coconut retrieval service error',
                status: error.response.status,
                detail: error.response.data
            });
        }

        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            return res.status(502).json({
                error: 'Coconut retrieval service unavailable',
                detail: `Could not connect to ${COCONUT_URL}`
            });
        }

        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({
                error: 'Coconut retrieval service timeout',
                detail: 'Request timed out waiting for response'
            });
        }

        console.error('[RAG] Unexpected error proxying to Coconut:', error.message);
        return res.status(500).json({
            error: 'Internal server error',
            detail: error.message
        });
    }
});

module.exports = router;
