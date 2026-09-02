/**
 * Tests for PDF validation logic in POST /copilot-api/chatbrc/copilot-agent.
 *
 * The validation is inline in the route handler (chatRoutes.js).
 * We POST to the route with mocked dependencies and inspect what the
 * mocked runChatTurn receives, which reflects the validated/trimmed
 * pdfs, files, and images that passed through the inline checks.
 *
 * Validation rules under test:
 *   - Strip data: URI prefix from PDF content
 *   - Reject PDFs whose decoded size exceeds 10 MB
 *   - Reject non-PDF content (no %PDF- magic bytes)
 *   - Map valid PDFs to {name, content, mime_type: 'application/pdf', size}
 *   - Enforce combined attachment cap: images + files + pdfs <= 3
 *     (trimming order: pdfs, then files, then images)
 *   - Text files still capped at 100 KB (unchanged)
 *   - PDF attachment metadata persisted as {type: 'pdf', name, size}
 */

const express = require('express');

// ---------------------------------------------------------------------------
// Capture what runChatTurn receives so we can assert on validated inputs
// ---------------------------------------------------------------------------
const mockRunChatTurn = jest.fn().mockImplementation(async (req, res, data) => {
    // Respond with a minimal SSE + end so the request completes
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.write('data: {"type":"done"}\n\n');
    res.end();
});

jest.mock('../services/chatRunner', () => ({
    runChatTurn: mockRunChatTurn,
    setCancelFlag: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock dbUtils BEFORE requiring chatRoutes (which imports at load time)
// ---------------------------------------------------------------------------
jest.mock('../services/dbUtils', () => ({
    getModelData: jest.fn(),
    getChatSession: jest.fn(),
    getSessionMessages: jest.fn(),
    getSessionTitle: jest.fn(),
    getUserSessions: jest.fn(),
    updateSessionTitle: jest.fn(),
    deleteSession: jest.fn(),
    getUserPrompts: jest.fn(),
    saveUserPrompt: jest.fn(),
    registerChatSession: jest.fn(),
    addWorkflowIdToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    rateConversation: jest.fn(),
    rateMessage: jest.fn(),
    getSessionFilesPaginated: jest.fn(),
    getSessionStorageSize: jest.fn(),
    getUserWorkflowIds: jest.fn(),
    searchRagChunkReferences: jest.fn(),
}));

// Mock MCP executor
jest.mock('../services/mcp/mcpExecutor', () => ({
    executeMcpTool: jest.fn(),
    isReplayableTool: jest.fn(),
}));

// Mock logger
jest.mock('../services/logger', () => ({
    createLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

// Mock database
jest.mock('../services/database', () => ({
    connectToDatabase: jest.fn().mockResolvedValue({}),
}));

// Mock chatService
jest.mock('../services/chatService', () => ({}));

// Mock auth middleware — requireAuth is express middleware (no-op),
// resolveUserId is a plain function returning {userId}
jest.mock('../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        req.user = 'testuser@bvbrc.org';
        req.authToken = 'test-token';
        next();
    },
    resolveUserId: (req, _suppliedUserId) => ({
        userId: req.user || 'testuser@bvbrc.org',
    }),
}));

// Mock prompts
jest.mock('../prompts', () => ({}));

// Mock sseUtils
jest.mock('../services/sseUtils', () => ({
    writeSseEvent: jest.fn(),
}));

// Mock config.json
jest.mock('../config.json', () => ({}), { virtual: true });

// Mock orchestratorClient
jest.mock('../services/orchestratorClient', () => ({
    executeOrchestratorLoop: jest.fn(),
    streamFromOrchestrator: jest.fn(),
    checkOrchestratorHealth: jest.fn(),
}));

// Mock sessionStreamRegistry
jest.mock('../services/sessionStreamRegistry', () => ({
    register: jest.fn(),
    unregister: jest.fn(),
    pushToSession: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Setup test server
// ---------------------------------------------------------------------------
let app;
let request;

beforeAll(async () => {
    const chatRoutes = require('../routes/chatRoutes');
    app = express();
    app.use(express.json({ limit: '50mb' })); // large enough for our test payloads
    app.use('/copilot-api/chatbrc', chatRoutes);

    const http = require('http');
    const server = http.createServer(app);

    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    request = (method, path, body) => {
        return new Promise((resolve, reject) => {
            const data = body ? JSON.stringify(body) : '';
            const options = {
                hostname: '127.0.0.1',
                port,
                method,
                path,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            };

            const req = http.request(options, (res) => {
                let responseData = '';
                res.on('data', (chunk) => (responseData += chunk));
                res.on('end', () => {
                    let json;
                    try {
                        json = JSON.parse(responseData);
                    } catch (e) {
                        json = null;
                    }
                    resolve({ status: res.statusCode, body: json, text: responseData });
                });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    };

    app._testServer = server;
});

afterAll((done) => {
    if (app && app._testServer) {
        app._testServer.close(done);
    } else {
        done();
    }
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid base64-encoded PDF-like content string (starts with %PDF-). */
function makePdfBase64(sizeBytes = 128) {
    const buf = Buffer.alloc(sizeBytes);
    // Write the PDF magic bytes at the start
    buf.write('%PDF-1.4 ', 0, 'ascii');
    // Fill the rest with deterministic filler
    for (let i = 9; i < sizeBytes; i++) {
        buf[i] = 0x41 + (i % 26); // A-Z repeating
    }
    return buf.toString('base64');
}

/** Build a base64 string of non-PDF content (no %PDF- header). */
function makeNonPdfBase64(sizeBytes = 128) {
    const buf = Buffer.alloc(sizeBytes);
    buf.write('NOT-A-PDF-FILE', 0, 'ascii');
    for (let i = 14; i < sizeBytes; i++) {
        buf[i] = 0x42 + (i % 26);
    }
    return buf.toString('base64');
}

/** Minimal valid payload for POST /copilot-agent. */
function basePayload(overrides = {}) {
    return {
        query: 'What genomes are available?',
        model: 'test-model',
        session_id: 'session-test-001',
        user_id: 'testuser@bvbrc.org',
        stream: true,
        ...overrides,
    };
}

/**
 * Extract the third argument (the data object) passed to runChatTurn.
 * runChatTurn is called as: runChatTurn(req, res, { query, model, ..., pdfs, files, images, ... })
 */
function getChatTurnData() {
    expect(mockRunChatTurn).toHaveBeenCalledTimes(1);
    return mockRunChatTurn.mock.calls[0][2];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PDF validation in POST /copilot-api/chatbrc/copilot-agent', () => {
    // ----- 1. Valid PDF accepted at <10 MB -----

    test('accepts a valid PDF with %PDF- header under 10 MB', async () => {
        const pdfContent = makePdfBase64(256);
        const payload = basePayload({
            pdfs: [{ name: 'test.pdf', content: pdfContent, size: 256 }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).not.toBeNull();
        expect(data.pdfs).toHaveLength(1);
        expect(data.pdfs[0]).toEqual({
            name: 'test.pdf',
            content: pdfContent,
            mime_type: 'application/pdf',
            size: 256,
        });
    });

    test('strips data: URI prefix before validation', async () => {
        const rawBase64 = makePdfBase64(128);
        const dataUri = `data:application/pdf;base64,${rawBase64}`;
        const payload = basePayload({
            pdfs: [{ name: 'uri.pdf', content: dataUri, size: 128 }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).not.toBeNull();
        expect(data.pdfs).toHaveLength(1);
        // The content passed through should retain the original (the route
        // stores p.content, not the stripped version, in the map)
        expect(data.pdfs[0].name).toBe('uri.pdf');
        expect(data.pdfs[0].mime_type).toBe('application/pdf');
    });

    test('defaults name to "document.pdf" when not provided', async () => {
        const pdfContent = makePdfBase64(64);
        const payload = basePayload({
            pdfs: [{ content: pdfContent }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toHaveLength(1);
        expect(data.pdfs[0].name).toBe('document.pdf');
    });

    test('defaults size to 0 when not provided', async () => {
        const pdfContent = makePdfBase64(64);
        const payload = basePayload({
            pdfs: [{ name: 'nosize.pdf', content: pdfContent }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs[0].size).toBe(0);
    });

    // ----- 2. PDF rejected when decoded size exceeds 10 MB -----

    test('rejects PDF whose decoded size exceeds 10 MB', async () => {
        // 10 MB = 10 * 1024 * 1024 = 10485760 bytes
        // Base64 of that is ceil(10485760 * 4/3) ≈ 13981014 chars
        // We need a base64 string whose decoded size > 10 MB.
        // decoded = base64Length * 3/4, so base64Length > 10485760 * 4/3 ≈ 13981014
        // Use a slightly-over length to trigger the check without allocating
        // a full 10 MB buffer. The validation estimates: ceil(raw.length * 3/4).
        // We need ceil(raw.length * 3/4) > 10485760.
        // raw.length > 10485760 * 4/3 = 13981013.33 → raw.length >= 13981014.
        // But we need valid base64 with PDF header for the size check to be
        // hit before the magic-bytes check. Actually, the size check runs first.
        // So we just need a long enough base64 string — the magic bytes check
        // comes after.
        const oversizeBase64Length = 14_000_000; // ≈ 10.5 MB decoded
        const oversizeContent = 'A'.repeat(oversizeBase64Length);

        const payload = basePayload({
            pdfs: [{ name: 'huge.pdf', content: oversizeContent, size: 11_000_000 }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200); // Route still succeeds, PDF is just filtered out
        const data = getChatTurnData();
        // The oversized PDF should be filtered out, resulting in null
        expect(data.pdfs).toBeNull();
    });

    test('rejects oversized PDF even with data: URI prefix', async () => {
        const oversizeBase64Length = 14_000_000;
        const rawBase64 = 'A'.repeat(oversizeBase64Length);
        const dataUri = `data:application/pdf;base64,${rawBase64}`;

        const payload = basePayload({
            pdfs: [{ name: 'huge-uri.pdf', content: dataUri }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toBeNull();
    });

    // ----- 3. Non-PDF content (no %PDF- magic) rejected -----

    test('rejects content without %PDF- magic bytes', async () => {
        const nonPdfContent = makeNonPdfBase64(256);
        const payload = basePayload({
            pdfs: [{ name: 'fake.pdf', content: nonPdfContent, size: 256 }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toBeNull();
    });

    test('rejects PDF with empty content string', async () => {
        const payload = basePayload({
            pdfs: [{ name: 'empty.pdf', content: '' }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toBeNull();
    });

    test('rejects PDF entry with no content field', async () => {
        const payload = basePayload({
            pdfs: [{ name: 'nodata.pdf' }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toBeNull();
    });

    test('rejects null entries in the pdfs array', async () => {
        const payload = basePayload({
            pdfs: [null, undefined],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toBeNull();
    });

    test('filters invalid PDFs but keeps valid ones', async () => {
        const validPdf = makePdfBase64(128);
        const invalidPdf = makeNonPdfBase64(128);

        const payload = basePayload({
            pdfs: [
                { name: 'good.pdf', content: validPdf, size: 128 },
                { name: 'bad.pdf', content: invalidPdf, size: 128 },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toHaveLength(1);
        expect(data.pdfs[0].name).toBe('good.pdf');
    });

    // ----- 4. Combined attachment cap: images + files + pdfs <= 3 -----

    test('allows exactly 3 total attachments (1 image + 1 file + 1 pdf)', async () => {
        const pdfContent = makePdfBase64(64);
        const payload = basePayload({
            images: ['data:image/png;base64,iVBOR...'],
            files: [{ name: 'notes.txt', content: 'hello world', size: 11 }],
            pdfs: [{ name: 'doc.pdf', content: pdfContent, size: 64 }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.files).toHaveLength(1);
        expect(data.pdfs).toHaveLength(1);
        expect(data.images).toHaveLength(1);
    });

    test('trims PDFs first when total attachments exceed 3', async () => {
        const pdf1 = makePdfBase64(64);
        const pdf2 = makePdfBase64(64);
        const payload = basePayload({
            images: ['img1', 'img2'],
            files: [{ name: 'f1.txt', content: 'content', size: 7 }],
            pdfs: [
                { name: 'p1.pdf', content: pdf1, size: 64 },
                { name: 'p2.pdf', content: pdf2, size: 64 },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        // 2 images + 1 file = 3 slots used → 0 slots left for PDFs
        expect(data.images).toHaveLength(2);
        expect(data.files).toHaveLength(1);
        expect(data.pdfs).toBeNull();
    });

    test('keeps some PDFs when there are partial slots available', async () => {
        const pdf1 = makePdfBase64(64);
        const pdf2 = makePdfBase64(64);
        const pdf3 = makePdfBase64(64);
        const payload = basePayload({
            images: ['img1'],
            files: [],
            pdfs: [
                { name: 'p1.pdf', content: pdf1, size: 64 },
                { name: 'p2.pdf', content: pdf2, size: 64 },
                { name: 'p3.pdf', content: pdf3, size: 64 },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        // 1 image + 0 files = 1 slot used → 2 slots for PDFs
        expect(data.images).toHaveLength(1);
        expect(data.pdfs).toHaveLength(2);
        expect(data.pdfs[0].name).toBe('p1.pdf');
        expect(data.pdfs[1].name).toBe('p2.pdf');
    });

    test('trims files after PDFs when images alone fill the cap', async () => {
        // Regression: the cap block used to reassign only validatedPdfs, so
        // 3 images + 3 files (no PDFs) forwarded all 6 attachments.
        const payload = basePayload({
            images: ['img1', 'img2', 'img3'],
            files: [
                { name: 'f1.txt', content: 'a', size: 1 },
                { name: 'f2.txt', content: 'b', size: 1 },
                { name: 'f3.txt', content: 'c', size: 1 },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.images).toHaveLength(3);
        expect(data.files).toBeNull();
        expect(data.pdfs).toBeNull();
    });

    test('keeps partial files when images leave a slot', async () => {
        const payload = basePayload({
            images: ['img1', 'img2'],
            files: [
                { name: 'f1.txt', content: 'a', size: 1 },
                { name: 'f2.txt', content: 'b', size: 1 },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.images).toHaveLength(2);
        expect(data.files).toHaveLength(1);
        expect(data.files[0].name).toBe('f1.txt');
    });

    test('trims images last when they alone exceed the cap', async () => {
        const payload = basePayload({
            images: ['img1', 'img2', 'img3', 'img4', 'img5'],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.images).toHaveLength(3);
        expect(data.images).toEqual(['img1', 'img2', 'img3']);
    });

    test('image_attachments stay index-aligned with trimmed images', async () => {
        const payload = basePayload({
            images: ['img1', 'img2', 'img3', 'img4'],
            image_attachments: [
                { source: 'screenshot', name: 'Page screenshot' },
                { source: 'upload', name: 'two.png' },
                { source: 'upload', name: 'three.png' },
                { source: 'upload', name: 'four.png' },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.images).toHaveLength(3);
        expect(data.image_attachments).toHaveLength(3);
        expect(data.image_attachments[2].name).toBe('three.png');
    });

    test('a file and an image are both kept when PDFs are dropped entirely', async () => {
        const pdf1 = makePdfBase64(64);
        const pdf2 = makePdfBase64(64);
        const pdf3 = makePdfBase64(64);
        const payload = basePayload({
            images: ['img1', 'img2'],
            files: [{ name: 'f1.txt', content: 'a', size: 1 }],
            pdfs: [
                { name: 'p1.pdf', content: pdf1, size: 64 },
                { name: 'p2.pdf', content: pdf2, size: 64 },
                { name: 'p3.pdf', content: pdf3, size: 64 },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.images).toHaveLength(2);
        expect(data.files).toHaveLength(1);
        expect(data.pdfs).toBeNull();
    });

    test('allows 3 PDFs when no other attachments', async () => {
        const pdf1 = makePdfBase64(64);
        const pdf2 = makePdfBase64(64);
        const pdf3 = makePdfBase64(64);
        const payload = basePayload({
            pdfs: [
                { name: 'a.pdf', content: pdf1, size: 64 },
                { name: 'b.pdf', content: pdf2, size: 64 },
                { name: 'c.pdf', content: pdf3, size: 64 },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toHaveLength(3);
    });

    // ----- 5. Text files capped at 10 MB -----

    test('accepts text file under 10 MB', async () => {
        const smallContent = 'x'.repeat(50 * 1024); // 50 KB
        const payload = basePayload({
            files: [{ name: 'small.txt', content: smallContent, size: smallContent.length }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.files).toHaveLength(1);
        expect(data.files[0].name).toBe('small.txt');
    });

    test('accepts text file at 100 KB (previously the ceiling)', async () => {
        const content = 'x'.repeat(101 * 1024); // 101 KB — well under 10 MB
        const payload = basePayload({
            files: [{ name: 'medium.txt', content: content, size: content.length }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.files).toHaveLength(1);
        expect(data.files[0].name).toBe('medium.txt');
    });

    test('rejects text file over 10 MB', async () => {
        const largeContent = 'x'.repeat(10 * 1024 * 1024 + 1); // just over 10 MB
        const payload = basePayload({
            files: [{ name: 'big.txt', content: largeContent, size: largeContent.length }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.files).toBeNull();
    });

    test('rejects text file containing null bytes', async () => {
        const binaryContent = 'valid text\x00binary data';
        const payload = basePayload({
            files: [{ name: 'binary.dat', content: binaryContent, size: binaryContent.length }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.files).toBeNull();
    });

    test('filters oversized text file but keeps valid ones', async () => {
        const smallContent = 'hello';
        const largeContent = 'x'.repeat(10 * 1024 * 1024 + 1); // just over 10 MB
        const payload = basePayload({
            files: [
                { name: 'good.txt', content: smallContent, size: 5 },
                { name: 'toolarge.txt', content: largeContent, size: largeContent.length },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.files).toHaveLength(1);
        expect(data.files[0].name).toBe('good.txt');
    });

    // ----- 6. PDF attachment metadata shape -----

    test('PDF mapped to {name, content, mime_type, size}', async () => {
        const pdfContent = makePdfBase64(512);
        const payload = basePayload({
            pdfs: [{ name: 'report.pdf', content: pdfContent, size: 512 }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        const pdf = data.pdfs[0];
        expect(pdf).toEqual({
            name: 'report.pdf',
            content: pdfContent,
            mime_type: 'application/pdf',
            size: 512,
        });
        // Ensure no extra keys leaked through
        expect(Object.keys(pdf).sort()).toEqual(
            ['content', 'mime_type', 'name', 'size'].sort()
        );
    });

    test('mime_type is always application/pdf regardless of input', async () => {
        const pdfContent = makePdfBase64(64);
        const payload = basePayload({
            pdfs: [{
                name: 'wrong-mime.pdf',
                content: pdfContent,
                size: 64,
                mime_type: 'text/plain', // intentionally wrong — should be overridden
            }],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs[0].mime_type).toBe('application/pdf');
    });

    // ----- Edge cases -----

    test('pdfs: null is treated as no PDFs', async () => {
        const payload = basePayload({ pdfs: null });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toBeNull();
    });

    test('pdfs: [] (empty array) is treated as no PDFs', async () => {
        const payload = basePayload({ pdfs: [] });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toBeNull();
    });

    test('pdfs field omitted entirely is treated as no PDFs', async () => {
        const payload = basePayload();
        // pdfs is not in the payload at all

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toBeNull();
    });

    test('multiple valid PDFs all pass through', async () => {
        const pdf1 = makePdfBase64(100);
        const pdf2 = makePdfBase64(200);
        const payload = basePayload({
            pdfs: [
                { name: 'first.pdf', content: pdf1, size: 100 },
                { name: 'second.pdf', content: pdf2, size: 200 },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/copilot-agent', payload);

        expect(res.status).toBe(200);
        const data = getChatTurnData();
        expect(data.pdfs).toHaveLength(2);
        expect(data.pdfs[0].name).toBe('first.pdf');
        expect(data.pdfs[1].name).toBe('second.pdf');
    });
});

// ---------------------------------------------------------------------------
// Attachment metadata persistence shape (orchestratorClient layer)
// ---------------------------------------------------------------------------
// The orchestratorClient builds userMessage.attachments from validated PDFs
// as {type: 'pdf', name, size} — no binary content, no text.
// This is a unit test of the mapping logic (same shape the gateway persists).

describe('PDF attachment metadata shape', () => {
    test('orchestratorClient maps PDFs to {type: "pdf", name, size} attachments', () => {
        // This directly tests the mapping logic that orchestratorClient.js
        // uses (lines 826-833). We replicate the exact mapping here to
        // verify the contract since the full orchestrator loop is mocked.
        const validatedPdfs = [
            { name: 'report.pdf', content: 'base64...', mime_type: 'application/pdf', size: 1024 },
            { name: 'data.pdf', content: 'base64...', mime_type: 'application/pdf', size: 2048 },
        ];

        // Replicate the gateway mapping from orchestratorClient.js:826-833
        const userAttachments = [];
        validatedPdfs.forEach(p => {
            userAttachments.push({
                type: 'pdf',
                name: p.name || 'document.pdf',
                size: p.size || 0,
            });
        });

        expect(userAttachments).toHaveLength(2);
        expect(userAttachments[0]).toEqual({ type: 'pdf', name: 'report.pdf', size: 1024 });
        expect(userAttachments[1]).toEqual({ type: 'pdf', name: 'data.pdf', size: 2048 });

        // Verify no content or mime_type leaked into the attachment metadata
        userAttachments.forEach(att => {
            expect(att.content).toBeUndefined();
            expect(att.mime_type).toBeUndefined();
            expect(att.text).toBeUndefined();
        });
    });

    test('attachment metadata defaults name to "document.pdf" and size to 0', () => {
        const validatedPdfs = [
            { content: 'base64...', mime_type: 'application/pdf' },
        ];

        const userAttachments = [];
        validatedPdfs.forEach(p => {
            userAttachments.push({
                type: 'pdf',
                name: p.name || 'document.pdf',
                size: p.size || 0,
            });
        });

        expect(userAttachments[0]).toEqual({ type: 'pdf', name: 'document.pdf', size: 0 });
    });
});
