## Folder Structure

```
services/
├── chatService.js                    # Main entry point (facade)
├── README.md                        # This documentation
├── chat/                            # Chat-related functionality
│   ├── core/                        # Core chat functionality
│   │   ├── chatHandlers.js          # Main request handlers
│   │   ├── contextBuilder.js        # Context preparation
│   │   └── dbUtils.js               # Database utilities
│   ├── streaming/                   # Streaming functionality
│   │   ├── streamingHandlers.js     # SSE/Streaming handlers
│   │   ├── streamStore.js           # In-memory stream storage
│   │   └── sseUtils.js              # SSE utility functions
│   └── utils/                       # Chat utilities
│       ├── messageUtils.js          # Message creation & formatting
│       ├── queryEnhancement.js      # Query processing
│       └── jsonUtils.js             # JSON utilities
├── llm/                             # LLM interaction layer
│   └── llmServices.js               # LLM API interactions
└── queries/                         # Query processing
    └── modelQueries.js              # Model query functions
```

## Module Organization

### 1. `chat/core/` - Core Chat Functionality
**Purpose**: Contains the main chat request handling and core business logic.

**Files**:
- **`chatHandlers.js`** - Main request handling functions
  - `handleCopilotRequest()` - Main copilot request handler
  - `handleChatRequest()` - Standard chat request handler
  - `handleRagRequest()` - RAG (Retrieval-Augmented Generation) request handler
  - `handleChatImageRequest()` - Image-based chat request handler
  - `handleLambdaDemo()` - Lambda demo request handler
  - `handleChatQuery()` - Simple chat query handler

- **`contextBuilder.js`** - Context preparation and enhancement
  - `prepareCopilotContext()` - Builds context for copilot requests
  - `createQueryFromMessages()` - Formats conversation history
  - `createMessage()` - Creates standardized message objects

- **`dbUtils.js`** - Database interaction utilities
  - Session management functions
  - Model and RAG database queries
  - Message persistence functions

### 2. `chat/streaming/` - Streaming Functionality
**Purpose**: Handles Server-Sent Events (SSE) and streaming responses.

**Files**:
- **`streamingHandlers.js`** - Streaming request handlers
  - `setupCopilotStream()` - Prepares context and setup for streaming
  - `handleCopilotStreamRequest()` - Handles streaming copilot requests

- **`streamStore.js`** - In-memory stream storage
  - Manages active streaming sessions
  - TTL cleanup for memory management

- **`sseUtils.js`** - SSE utility functions
  - `sendSseError()` - Error handling for SSE
  - `startKeepAlive()`, `stopKeepAlive()` - Connection management

### 3. `chat/utils/` - Chat Utilities
**Purpose**: Contains utility functions for message handling and query processing.

**Files**:
- **`messageUtils.js`** - Message utilities
  - `createMessage()` - Creates standardized message objects
  - `createQueryFromMessages()` - Formats conversation history into queries

- **`queryEnhancement.js`** - Query processing
  - `enhanceQuery()` - Enhances user queries with context

- **`jsonUtils.js`** - JSON utilities
  - `safeParseJson()` - Safe JSON parsing with error handling

### 4. `llm/` - LLM Interaction Layer
**Purpose**: Contains functions for interacting with language models and external APIs.

**Files**:
- **`llmServices.js`** - LLM API interactions
  - OpenAI client setup and management
  - Various query functions (chat, embedding, RAG, etc.)
  - Error handling and service management

### 5. `queries/` - Query Processing
**Purpose**: Contains model querying and API interaction functions.

**Files**:
- **`modelQueries.js`** - Model query functions
  - `getOpenaiClient()` - Creates OpenAI client instances
  - `queryModel()` - Queries models with messages
  - `queryRequest()` - Makes request-based model queries
  - `runModel()` - Main model execution function
  - `runModelStream()` - Streaming model execution
  - `getPathState()` - Gets path state from external service

### 6. `chatService.js` - Main Entry Point
**Purpose**: Acts as the main entry point, importing and re-exporting all functions from the modular structure.

## Benefits of This Organization

1. **Logical Grouping**: Related functionality is grouped together in subfolders
2. **Improved Maintainability**: Each module has a single responsibility
3. **Better Organization**: Clear separation between core, streaming, and utility functions
4. **Easier Testing**: Individual modules can be tested in isolation
5. **Reduced Complexity**: Smaller files are easier to understand and modify
6. **Better Code Reuse**: Functions can be imported individually as needed

## Usage

The main `chatService.js` file maintains the same public API, so existing code that imports from it will continue to work without changes. All the original functions are still available through the same import:

```javascript
const {
  handleCopilotRequest,
  handleChatRequest,
  handleRagRequest,
  // ... etc
} = require('./chatService');
```

## Dependencies

Each module has its own specific dependencies:
- `chat/core/` modules depend on `llm/`, `queries/`, and `chat/utils/`
- `chat/streaming/` modules depend on `chat/core/`, `chat/utils/`, and `queries/`
- `chat/utils/` modules depend on `llm/` and `chat/core/`
- `queries/` modules depend on `llm/` and `chat/core/`
- `llm/` modules are self-contained

This organized structure makes the codebase more maintainable and easier to understand while preserving all existing functionality. 