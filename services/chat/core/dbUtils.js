const { connectToDatabase } = require('../database');
const { LLMServiceError } = require('./llmServices');
const { formatSize } = require('./fileUtils');

/**
 * Get model data from the database
 * @param {string} model - The model name to look up
 * @returns {Object} Model data object
 * @throws {LLMServiceError} If model is not found
 */
async function getModelData(model) {
  try {
    const db = await connectToDatabase();
    const modelData = await db.collection('modelList').findOne({ model });

    if (!modelData) {
      throw new LLMServiceError(`Invalid model: ${model}`);
    }

    return modelData;
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to get model data', error);
  }
}

/**
 * Get all active models of a specific type
 * @param {string} modelType - The model type to filter by (e.g., 'chat')
 * @returns {Array} Array of active model objects
 */
async function getActiveModels(modelType = 'chat') {
  try {
    const db = await connectToDatabase();
    const modelCollection = db.collection('modelList');
    return await modelCollection.find({ active: true, model_type: modelType }).sort({ priority: 1 }).toArray();
  } catch (error) {
    throw new LLMServiceError('Failed to get active models', error);
  }
}

/**
 * Get all active RAG databases
 * @returns {Array} Array of active RAG database objects
 */
async function getActiveRagDatabases() {
  try {
    const db = await connectToDatabase();
    const ragCollection = db.collection('ragList');
    return await ragCollection.find({ active: true }).sort({ priority: 1 }).toArray();
  } catch (error) {
    throw new LLMServiceError('Failed to get active RAG databases', error);
  }
}

/**
 * Get RAG database configuration
 * @param {string} ragDbName - The RAG database name to look up
 * @returns {Object} RAG database configuration
 * @throws {LLMServiceError} If RAG database is not found
 */
async function getRagData(ragDbName) {
  try {
    const db = await connectToDatabase();
    const ragData = await db.collection('ragList').findOne({ name: ragDbName });

    if (!ragData) {
      throw new LLMServiceError(`Invalid RAG database: ${ragDbName}`);
    }

    return ragData;
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to get RAG data', error);
  }
}

/**
 * Get chat session from database
 * @param {string} sessionId - The session ID to look up
 * @returns {Object|null} Chat session object or null if not found
 */
async function getChatSession(sessionId) {
  try {
    if (!sessionId) {
      return null;
    }
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');
    const session = await chatCollection.findOne({ session_id: sessionId });

    return session;
  } catch (error) {
    throw new LLMServiceError('Failed to get chat session', error);
  }
}

/**
 * Get session messages
 * @param {string} sessionId - The session ID to look up
 * @returns {Array} Array of messages for the session
 */
async function getSessionMessages(sessionId) {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');
    const query = { session_id: sessionId };
    const result = await chatCollection
      .find(query)
      .project({
        'messages.embedding': 0
      })
      .sort({ timestamp: -1 })
      .toArray();
    
    // Extract messages array from the first session document
    if (result && result.length > 0 && result[0].messages) {
      const messages = result[0].messages;
      return messages;
    }
    return [];
  } catch (error) {
    throw new LLMServiceError('Failed to get session messages', error);
  }
}

/**
 * Search stored RAG chunk references from chat session system messages.
 * @param {object} filters - Search filters
 * @param {string} [filters.chunk_id] - Chunk identifier
 * @param {string} [filters.rag_db] - RAG database/config name
 * @param {string} [filters.rag_api_name] - RAG API name metadata
 * @param {string} [filters.doc_id] - Source document identifier
 * @param {string} [filters.source_id] - Source record/file identifier
 * @param {string} [filters.session_id] - Session identifier
 * @param {string} [filters.user_id] - User identifier
 * @param {string} [filters.message_id] - Message identifier
 * @param {number} [filters.limit=50] - Page size
 * @param {number} [filters.offset=0] - Page offset
 * @param {boolean} [filters.include_content=false] - Include chunk text content
 * @returns {object} Paginated chunk references
 */
async function searchRagChunkReferences(filters = {}) {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');

    const limit = Number.isFinite(filters.limit) ? Math.min(Math.max(filters.limit, 1), 200) : 50;
    const offset = Number.isFinite(filters.offset) && filters.offset >= 0 ? filters.offset : 0;
    const includeContent = filters.include_content === true;

    const sessionMatch = {};
    if (filters.session_id) sessionMatch.session_id = filters.session_id;
    if (filters.user_id) sessionMatch.user_id = filters.user_id;

    const pipeline = [];
    if (Object.keys(sessionMatch).length > 0) {
      pipeline.push({ $match: sessionMatch });
    }

    pipeline.push(
      { $unwind: '$messages' },
      { $match: { 'messages.role': 'system', 'messages.documents': { $type: 'array' } } },
      { $unwind: '$messages.documents' },
      { $match: { 'messages.documents': { $type: 'object' } } },
      {
        $project: {
          _id: 0,
          session_id: '$session_id',
          user_id: '$user_id',
          message_id: '$messages.message_id',
          message_timestamp: '$messages.timestamp',
          content: '$messages.documents.content',
          score: '$messages.documents.score',
          metadata: { $ifNull: ['$messages.documents.metadata', {}] },
          chunk_id: {
            $ifNull: [
              '$messages.documents.metadata.chunk_id',
              { $ifNull: ['$messages.documents.metadata.chunkId', '$messages.documents.chunk_id'] }
            ]
          },
          doc_id: {
            $ifNull: [
              '$messages.documents.metadata.doc_id',
              { $ifNull: ['$messages.documents.metadata.document_id', '$messages.documents.doc_id'] }
            ]
          },
          source_id: {
            $ifNull: [
              '$messages.documents.metadata.source_id',
              { $ifNull: ['$messages.documents.metadata.source', '$messages.documents.metadata.record_id'] }
            ]
          },
          rag_db: {
            $ifNull: [
              '$messages.documents.metadata.rag_db',
              '$messages.documents.metadata.config_name'
            ]
          },
          rag_api_name: '$messages.documents.metadata.rag_api_name'
        }
      }
    );

    const resultMatch = {};
    if (filters.chunk_id) resultMatch.chunk_id = filters.chunk_id;
    if (filters.rag_db) resultMatch.rag_db = filters.rag_db;
    if (filters.rag_api_name) resultMatch.rag_api_name = filters.rag_api_name;
    if (filters.doc_id) resultMatch.doc_id = filters.doc_id;
    if (filters.source_id) resultMatch.source_id = filters.source_id;
    if (filters.message_id) resultMatch.message_id = filters.message_id;
    if (Object.keys(resultMatch).length > 0) {
      pipeline.push({ $match: resultMatch });
    }

    const countPipeline = [...pipeline, { $count: 'total' }];
    const totalResult = await chatCollection.aggregate(countPipeline).toArray();
    const total = totalResult[0]?.total || 0;

    pipeline.push(
      { $sort: { message_timestamp: -1 } },
      { $skip: offset },
      { $limit: limit }
    );

    const rows = await chatCollection.aggregate(pipeline).toArray();
    const items = rows.map((row) => ({
      session_id: row.session_id || null,
      user_id: row.user_id || null,
      message_id: row.message_id || null,
      message_timestamp: row.message_timestamp || null,
      chunk_id: row.chunk_id || null,
      doc_id: row.doc_id || null,
      source_id: row.source_id || null,
      rag_db: row.rag_db || null,
      rag_api_name: row.rag_api_name || null,
      score: Number.isFinite(row.score) ? row.score : null,
      ...(includeContent ? { content: row.content || '' } : {}),
      metadata: row.metadata || {}
    }));

    return {
      items,
      total,
      limit,
      offset,
      has_more: offset + items.length < total
    };
  } catch (error) {
    throw new LLMServiceError('Failed to search RAG chunk references', error);
  }
}

/**
 * Get session title
 * @param {string} sessionId - The session ID to look up
 * @returns {Array} Array containing the title
 */
async function getSessionTitle(sessionId) {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');
    return await chatCollection.find({ session_id: sessionId }).project({ title: 1 }).toArray();
  } catch (error) {
    throw new LLMServiceError('Failed to get session title', error);
  }
}

/**
 * Get all sessions for a user
 * @param {string} userId - The user ID to look up
 * @returns {Array} Array of chat sessions for the user
 */
async function getUserSessions(userId, limit = 20, offset = 0) {
  try {
    // Ensure numeric values and enforce bounds
    limit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
    offset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');
    const query = { user_id: userId };

    // Total number of sessions for the user (without pagination)
    const total = await chatCollection.countDocuments(query);

    // Fetch paginated sessions ordered by newest first
    const sessions = await chatCollection
      .find(query)
      // Sort by last_modified if it exists; otherwise fall back to created_at
      .sort({ last_modified: -1, created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    const normalizedSessions = sessions.map((session) => ({
      ...session,
      workflow_ids: Array.isArray(session.workflow_ids) ? session.workflow_ids : []
    }));

    return { sessions: normalizedSessions, total };
  } catch (error) {
    throw new LLMServiceError('Failed to get user sessions', error);
  }
}

/**
 * Update session title
 * @param {string} sessionId - The session ID
 * @param {string} userId - The user ID
 * @param {string} title - The new title
 * @returns {Object} Update result
 */
async function updateSessionTitle(sessionId, userId, title) {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');
    return await chatCollection.updateOne(
      { session_id: sessionId, user_id: userId },
      { $set: { title } }
    );
  } catch (error) {
    throw new LLMServiceError('Failed to update session title', error);
  }
}

/**
 * Delete a chat session
 * @param {string} sessionId - The session ID
 * @param {string} userId - The user ID
 * @returns {Object} Delete result
 */
async function deleteSession(sessionId, userId) {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');
    return await chatCollection.deleteOne({ session_id: sessionId, user_id: userId });
  } catch (error) {
    throw new LLMServiceError('Failed to delete session', error);
  }
}

/**
 * Get user prompts
 * @param {string} userId - The user ID
 * @returns {Array} Array of user prompts
 */
async function getUserPrompts(userId) {
  try {
    const db = await connectToDatabase();
    const promptsCollection = db.collection('prompts');
    return await promptsCollection.find({ user_id: userId }).sort({ created_at: -1 }).toArray();
  } catch (error) {
    throw new LLMServiceError('Failed to get user prompts', error);
  }
}

/**
 * Save a user prompt
 * @param {string} userId - The user ID
 * @param {string} name - The prompt name/title
 * @param {string} text - The prompt text
 * @returns {Object} Update result
 */
async function saveUserPrompt(userId, name, text) {
  try {
    const db = await connectToDatabase();
    const promptsCollection = db.collection('prompts');
    return await promptsCollection.updateOne(
      { user_id: userId },
      { $push: { saved_prompts: { title: name, text } } }
    );
  } catch (error) {
    throw new LLMServiceError('Failed to save user prompt', error);
  }
}

/**
 * Create a new chat session
 * @param {string} sessionId - The session ID
 * @param {string} userId - The user ID
 * @param {string} title - The session title (default: 'Untitled')
 * @returns {Object} Insert result
 */
async function createChatSession(sessionId, userId, title = 'Untitled') {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');

    const result = await chatCollection.insertOne({
      session_id: sessionId,
      user_id: userId,
      title,
      created_at: new Date(),
      messages: [],
      workflow_ids: [],
      last_modified: new Date()
    });

    return result;
  } catch (error) {
    throw new LLMServiceError('Failed to create chat session', error);
  }
}

/**
 * Register a chat session idempotently.
 * Creates a new session when missing, otherwise only refreshes last_modified.
 * @param {string} sessionId - The session ID
 * @param {string} userId - The user ID
 * @param {string} title - Optional title for newly created sessions
 * @returns {Object} Registration result with created flag
 */
async function registerChatSession(sessionId, userId, title = 'New Chat') {
  try {
    if (!sessionId || !userId) {
      throw new LLMServiceError('Session ID and user ID are required');
    }

    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');
    const now = new Date();
    const normalizedTitle = (typeof title === 'string' && title.trim()) ? title.trim() : 'New Chat';

    const result = await chatCollection.updateOne(
      { session_id: sessionId, user_id: userId },
      {
        $setOnInsert: {
          session_id: sessionId,
          user_id: userId,
          title: normalizedTitle,
          created_at: now,
          messages: [],
          workflow_ids: []
        },
        $set: { last_modified: now }
      },
      { upsert: true }
    );

    return {
      created: !!result.upsertedCount,
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upsertedId: result.upsertedId || null
    };
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to register chat session', error);
  }
}

/**
 * Add a workflow ID to a chat session.
 * Uses $addToSet so duplicates are ignored.
 * @param {string} sessionId - The session ID
 * @param {string} workflowId - Workflow ID to add
 * @returns {Object} Update result
 */
async function addWorkflowIdToSession(sessionId, workflowId) {
  try {
    if (!sessionId || !workflowId) {
      return null;
    }
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');
    return await chatCollection.updateOne(
      { session_id: sessionId },
      {
        $addToSet: { workflow_ids: workflowId },
        $set: { last_modified: new Date() }
      }
    );
  } catch (error) {
    throw new LLMServiceError('Failed to add workflow ID to session', error);
  }
}

/**
 * Add messages to a chat session
 * @param {string} sessionId - The session ID
 * @param {Array} messages - Array of message objects to add
 * @returns {Object} Update result
 */
async function addMessagesToSession(sessionId, messages) {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');

    return await chatCollection.updateOne(
      { session_id: sessionId },
      {
        $push: { messages: { $each: messages } },
        $set: { last_modified: new Date() }
      }
    );
  } catch (error) {
    throw new LLMServiceError('Failed to add messages to session', error);
  }
}

/**
 * Get or create chat session
 * @param {string} sessionId - The session ID
 * @param {string} userId - The user ID
 * @param {string} title - The session title (default: 'Untitled')
 * @returns {Object} Chat session object
 */
async function getOrCreateChatSession(sessionId, userId, title = 'Untitled') {
  try {
    let chatSession = await getChatSession(sessionId);

    if (!chatSession) {
      await createChatSession(sessionId, userId, title);
      chatSession = await getChatSession(sessionId);
    }

    return chatSession;
  } catch (error) {
    throw new LLMServiceError('Failed to get or create chat session', error);
  }
}

/**
 * Save or update summary for a session
 * @param {string} sessionId - The session ID
 * @param {string} summary - The summary text
 * @returns {Object} Update result
 */
async function saveSummary(sessionId, summary) {
  try {
    const db = await connectToDatabase();
    const summaryCollection = db.collection('chatSummaries');

    return await summaryCollection.updateOne(
      { session_id: sessionId },
      { $set: { summary, updated_at: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    throw new LLMServiceError('Failed to save summary', error);
  }
}

/**
 * Get summary document for a session
 * @param {string} sessionId - The session ID
 * @returns {Object|null} Summary document or null
 */
async function getSummaryBySessionId(sessionId) {
  try {
    if (!sessionId) return null;
    const db = await connectToDatabase();
    const summaryCollection = db.collection('chatSummaries');
    return await summaryCollection.findOne({ session_id: sessionId });
  } catch (error) {
    throw new LLMServiceError('Failed to get summary', error);
  }
}

/**
 * Save or update summary document with metadata
 * @param {string} sessionId - The session ID
 * @param {string} userId - The user ID
 * @param {object} summaryDoc - Summary fields to write
 * @returns {Object} Update result
 */
async function saveSummaryDoc(sessionId, userId, summaryDoc = {}) {
  try {
    const db = await connectToDatabase();
    const summaryCollection = db.collection('chatSummaries');
    const updateDoc = {
      ...summaryDoc,
      session_id: sessionId,
      user_id: userId,
      updated_at: new Date()
    };
    return await summaryCollection.updateOne(
      { session_id: sessionId },
      { $set: updateDoc },
      { upsert: true }
    );
  } catch (error) {
    throw new LLMServiceError('Failed to save summary document', error);
  }
}

/**
 * Rate a conversation session
 * @param {string} sessionId - The session ID to rate
 * @param {string} userId - The user ID (for security/validation)
 * @param {number} rating - The rating value (typically 1-5)
 * @returns {Object} Update result
 */
async function rateConversation(sessionId, userId, rating) {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');

    const result = await chatCollection.updateOne(
      { session_id: sessionId, user_id: userId },
      { $set: { rating, rated_at: new Date() } }
    );

    if (result.matchedCount === 0) {
      throw new LLMServiceError(`Session not found or user not authorized: ${sessionId}`);
    }

    return result;
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to rate conversation', error);
  }
}

/**
 * Rate a message
 * @param {string} userId - The user ID
 * @param {string} messageId - The message ID
 * @param {number} rating - The rating value (-1, 0, 1)
 * @returns {Object} Update result
 */
async function rateMessage(userId, messageId, rating) {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');

    const result = await chatCollection.updateOne(
      { user_id: userId, 'messages.message_id': messageId },
      { $set: { 'messages.$.rating': rating } }
    );

    if (result.matchedCount === 0) {
      throw new LLMServiceError(`Message not found or user not authorized: ${messageId}`);
    }

    return result;
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to rate message', error);
  }
}

/**
 * Store message embedding in database
 * @param {string} sessionId - The session ID
 * @param {string} messageId - The message ID
 * @param {Array<number>} embedding - The 1D vector embedding (array of numbers)
 * @returns {Object} Insert result
 */
async function storeMessageEmbedding(sessionId, messageId, embedding) {
  try {
    const db = await connectToDatabase();
    const embeddingsCollection = db.collection('message_embeddings');

    const result = await embeddingsCollection.insertOne({
      session_id: sessionId,
      message_id: messageId,
      embedding,
      created_at: new Date()
    });

    return result;
  } catch (error) {
    throw new LLMServiceError('Failed to store message embedding', error);
  }
}

/**
 * Get all embeddings for a session
 * @param {string} sessionId - The session ID to look up
 * @returns {Array} Array of embedding objects for the session
 */
async function getEmbeddingsBySessionId(sessionId) {
  try {
    const db = await connectToDatabase();
    const embeddingsCollection = db.collection('message_embeddings');

    const embeddings = await embeddingsCollection
      .find({ session_id: sessionId })
      .sort({ created_at: 1 })
      .toArray();

    return embeddings;
  } catch (error) {
    throw new LLMServiceError('Failed to get embeddings by session ID', error);
  }
}

/**
 * Get embedding by message ID
 * @param {string} messageId - The message ID to look up
 * @returns {Object|null} Embedding object or null if not found
 */
async function getEmbeddingByMessageId(messageId) {
  try {
    const db = await connectToDatabase();
    const embeddingsCollection = db.collection('message_embeddings');

    const embedding = await embeddingsCollection.findOne({ message_id: messageId });

    return embedding;
  } catch (error) {
    throw new LLMServiceError('Failed to get embedding by message ID', error);
  }
}

/**
 * Get database collections commonly used in chat operations
 * @returns {Object} Object containing database and collection references
 */
async function getChatCollections() {
  try {
    const db = await connectToDatabase();
    return {
      db,
      chatCollection: db.collection('chat_sessions'),
      summaryCollection: db.collection('chatSummaries'),
      modelCollection: db.collection('modelList'),
      ragCollection: db.collection('ragList')
    };
  } catch (error) {
    throw new LLMServiceError('Failed to get database collections', error);
  }
}

/**
 * Save file metadata to database
 * @param {string} sessionId - The session ID
 * @param {object} fileMetadata - File metadata object
 * @returns {Object} Insert result
 */
async function saveFileMetadata(sessionId, fileMetadata) {
  try {
    const db = await connectToDatabase();
    const filesCollection = db.collection('session_files');

    const result = await filesCollection.insertOne({
      session_id: sessionId,
      ...fileMetadata,
      created_at: new Date()
    });

    return result;
  } catch (error) {
    throw new LLMServiceError('Failed to save file metadata', error);
  }
}

/**
 * Get file metadata by fileId and sessionId
 * @param {string} sessionId - The session ID
 * @param {string} fileId - The file ID
 * @returns {Object|null} File metadata or null if not found
 */
async function getFileMetadata(sessionId, fileId) {
  try {
    const db = await connectToDatabase();
    const filesCollection = db.collection('session_files');

    const fileMetadata = await filesCollection.findOne({
      session_id: sessionId,
      fileId: fileId
    });

    if (fileMetadata) {
      // Update last accessed time
      await filesCollection.updateOne(
        { _id: fileMetadata._id },
        { $set: { lastAccessed: new Date() } }
      );
    }

    return fileMetadata;
  } catch (error) {
    throw new LLMServiceError('Failed to get file metadata', error);
  }
}

/**
 * Get all file metadata for a session
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of file metadata objects
 */
async function getSessionFiles(sessionId) {
  try {
    const db = await connectToDatabase();
    const filesCollection = db.collection('session_files');

    return await filesCollection
      .find({ session_id: sessionId })
      .sort({ created_at: -1 })
      .toArray();
  } catch (error) {
    throw new LLMServiceError('Failed to get session files', error);
  }
}

/**
 * Convert stored file metadata into a client-safe DTO.
 * Intentionally excludes internal fields like local filesystem paths.
 * @param {object} fileMetadata - Stored file metadata document
 * @returns {object} Client-safe file metadata
 */
function mapSessionFileToClient(fileMetadata) {
  const createdAt = fileMetadata.created_at || fileMetadata.created || null;
  const sizeBytes = Number.isFinite(fileMetadata.size) ? fileMetadata.size : 0;

  return {
    file_id: fileMetadata.fileId,
    file_name: fileMetadata.fileName || null,
    tool_id: fileMetadata.toolId || null,
    created_at: createdAt,
    last_accessed: fileMetadata.lastAccessed || null,
    data_type: fileMetadata.dataType || null,
    size_bytes: sizeBytes,
    size_formatted: formatSize(sizeBytes),
    record_count: Number.isFinite(fileMetadata.recordCount) ? fileMetadata.recordCount : 0,
    fields: Array.isArray(fileMetadata.fields) ? fileMetadata.fields : [],
    is_error: fileMetadata.isError === true,
    workspace_path: fileMetadata.workspacePath || null,
    workspace_url: fileMetadata.workspaceUrl || null,
    query_parameters: fileMetadata.queryParameters || null
  };
}

/**
 * Get paginated, client-safe file metadata for a session
 * @param {string} sessionId - The session ID
 * @param {number} limit - Page size
 * @param {number} offset - Page offset
 * @returns {object} Paginated file metadata
 */
async function getSessionFilesPaginated(sessionId, limit = 20, offset = 0) {
  try {
    limit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
    offset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

    const db = await connectToDatabase();
    const filesCollection = db.collection('session_files');
    const query = { session_id: sessionId };

    const total = await filesCollection.countDocuments(query);
    const files = await filesCollection
      .find(query)
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    return {
      files: files.map(mapSessionFileToClient),
      total,
      limit,
      offset,
      has_more: offset + files.length < total
    };
  } catch (error) {
    throw new LLMServiceError('Failed to get paginated session files', error);
  }
}

/**
 * Delete file metadata
 * @param {string} sessionId - The session ID
 * @param {string} fileId - The file ID
 * @returns {Object} Delete result
 */
async function deleteFileMetadata(sessionId, fileId) {
  try {
    const db = await connectToDatabase();
    const filesCollection = db.collection('session_files');

    const result = await filesCollection.deleteOne({
      session_id: sessionId,
      fileId: fileId
    });

    return result;
  } catch (error) {
    throw new LLMServiceError('Failed to delete file metadata', error);
  }
}

/**
 * Get total storage used by a session
 * @param {string} sessionId - The session ID
 * @returns {number} Total size in bytes
 */
async function getSessionStorageSize(sessionId) {
  try {
    const db = await connectToDatabase();
    const filesCollection = db.collection('session_files');

    const result = await filesCollection.aggregate([
      { $match: { session_id: sessionId } },
      { $group: { _id: null, totalSize: { $sum: '$size' } } }
    ]).toArray();

    return result.length > 0 ? result[0].totalSize : 0;
  } catch (error) {
    throw new LLMServiceError('Failed to get session storage size', error);
  }
}

/**
 * Get unique workflow IDs referenced by any chat session for a user.
 * @param {string} userId - The user ID
 * @returns {Array<string>} Unique workflow IDs
 */
async function getUserWorkflowIds(userId) {
  try {
    const db = await connectToDatabase();
    const chatCollection = db.collection('chat_sessions');

    const sessions = await chatCollection
      .find({ user_id: userId })
      .project({ workflow_ids: 1 })
      .toArray();

    const uniqueIds = new Set();
    sessions.forEach((session) => {
      const ids = Array.isArray(session.workflow_ids) ? session.workflow_ids : [];
      ids.forEach((id) => {
        if (typeof id === 'string' && id.trim().length > 0) {
          uniqueIds.add(id.trim());
        }
      });
    });

    return Array.from(uniqueIds);
  } catch (error) {
    throw new LLMServiceError('Failed to get user workflow IDs', error);
  }
}

module.exports = {
  getModelData,
  getActiveModels,
  getActiveRagDatabases,
  getRagData,
  getChatSession,
  getSessionMessages,
  searchRagChunkReferences,
  getSessionTitle,
  getUserSessions,
  updateSessionTitle,
  deleteSession,
  getUserPrompts,
  saveUserPrompt,
  createChatSession,
  registerChatSession,
  addWorkflowIdToSession,
  addMessagesToSession,
  getOrCreateChatSession,
  saveSummary,
  getSummaryBySessionId,
  saveSummaryDoc,
  rateConversation,
  rateMessage,
  storeMessageEmbedding,
  getEmbeddingsBySessionId,
  getEmbeddingByMessageId,
  getChatCollections,
  saveFileMetadata,
  getFileMetadata,
  getSessionFiles,
  getSessionFilesPaginated,
  deleteFileMetadata,
  getSessionStorageSize,
  getUserWorkflowIds
};
