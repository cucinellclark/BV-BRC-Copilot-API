// index.js

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { OpenAI } = require('openai');

const chatRoutes = require('./routes/chatRoutes'); // chat-related routes
const dbRoutes = require('./routes/dbRoutes');

const app = express();

// Middleware setup
const size_limit = '50mb'
app.use(cors()); // Enable CORS for all routes
app.use(express.json({ limit: size_limit })); // limit: '1mb' Parse JSON requests
app.use(bodyParser.json({ limit: size_limit })); // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true, limit: size_limit })); // for parsing application/x-www-form-urlencoded

// Simple route to test API functionality
app.get('/copilot-api/test', (req, res) => {
    res.send('Welcome to my API');
});

// Register chat-related routes with the Express app
app.use('/copilot-api/chatbrc', chatRoutes);
app.use('/copilot-api/db', dbRoutes);

module.exports = app;
