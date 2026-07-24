// index.js

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { OpenAI } = require('openai');

const chatRoutes = require('./routes/chatRoutes'); // chat-related routes
const dbRoutes = require('./routes/dbRoutes');
const healthRoutes = require('./routes/healthRoutes'); // health check routes
const ragRoutes = require('./routes/ragRoutes'); // RAG retrieval routes

const app = express();

// Middleware setup
const size_limit = '50mb'

// CORS: restrict to known BV-BRC origins.
// Add development origins as needed (e.g. http://localhost:3000).
const corsOptions = {
    origin: [
        'https://alpha.bv-brc.org',
        'https://www.bv-brc.org',
        'https://bv-brc.org',
        'https://dev-3.bv-brc.org',
        'https://dev-4.bv-brc.org',
        'https://dev-5.bv-brc.org',
        'https://dev-6.bv-brc.org',
        'https://dev-8.bv-brc.org',
        'https://dev-7.bv-brc.org',
        'http://localhost:3000',
        'http://localhost:5173'
    ],
    credentials: true
};
// Default CORS policy (restricted allowlist).
// RAG routes are excluded here because they use a wildcard origin policy
// handled entirely by ragCors in ragRoutes.js.  Without this skip the global
// cors middleware intercepts OPTIONS preflight and returns 204 *without*
// Access-Control-Allow-Origin when the request origin isn't in the allowlist,
// which blocks browsers on unlisted dev servers.
app.use((req, res, next) => {
    if (req.path.startsWith('/copilot-api/rag')) {
        return next();
    }
    cors(corsOptions)(req, res, next);
});

app.use(express.json({ limit: size_limit })); // limit: '1mb' Parse JSON requests
app.use(bodyParser.json({ limit: size_limit })); // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true, limit: size_limit })); // for parsing application/x-www-form-urlencoded

// Simple route to test API functionality
app.get('/copilot-api/test', (req, res) => {
    res.send('Welcome to my API');
});

// Register routes with the Express app
app.use('/copilot-api/health', healthRoutes);
app.use('/copilot-api/chatbrc', chatRoutes);
app.use('/copilot-api/db', dbRoutes);

app.use('/copilot-api/rag', ragRoutes);

module.exports = app;
