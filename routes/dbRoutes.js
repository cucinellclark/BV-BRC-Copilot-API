// routes/dbRoutes.js

const express = require('express');
const { getActiveModels, getActiveRagDatabases } = require('../services/dbUtils');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// The browser only needs what it shows and uses to pick a default.
// endpoint / apiKey / queryType (and RAG rag_endpoint / data paths) are
// server-side routing details; the model is resolved again from Mongo by
// name on every chat turn (orchestratorClient getModelData).
const PUBLIC_MODEL_FIELDS = ['model', 'model_type', 'active', 'priority', 'max_tokens', 'supports_image', 'is_default'];
const PUBLIC_RAG_FIELDS = ['name', 'active', 'priority'];

function pickFields(doc, fields) {
    const out = {};
    for (const f of fields) {
        if (doc[f] !== undefined) out[f] = doc[f];
    }
    return out;
}

router.post('/get-model-list', requireAuth, async (req, res) => {
    try {
        const models = (await getActiveModels('chat')).map((m) => pickFields(m, PUBLIC_MODEL_FIELDS));
        const rags = (await getActiveRagDatabases()).map((r) => pickFields(r, PUBLIC_RAG_FIELDS));

        res.status(200).json({ models: JSON.stringify(models), vdb_list: JSON.stringify(rags) });

    } catch (error) {
        console.error('Error getting model list:', error.message || error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
