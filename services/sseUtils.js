// services/sseUtils.js

/**
 * Write an SSE event and flush immediately to prevent buffering
 * Critical for proper SSE behavior when running under pm2
 */
function writeSseEvent(res, eventType, data) {
  try {
    if (eventType) {
      res.write(`event: ${eventType}\n`);
    }
    if (data) {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
      res.write(`data: ${dataStr}\n`);
    }
    res.write('\n');
    
    // Explicitly flush to prevent buffering (critical for pm2)
    if (typeof res.flush === 'function') {
      res.flush();
    }
  } catch (error) {
    /* connection might already be closed */
  }
}

/**
 * Send a Server-Sent-Events style error message and close the stream.
 */
function sendSseError(res, errorMsg) {
  try {
    writeSseEvent(res, 'error', { error: errorMsg });
    res.end();
  } catch (_) {
    /* connection might already be closed */
  }
}

/**
 * Start a periodic keep-alive comment (": keep-alive") on an SSE response.
 * Returns the interval ID so the caller can clear it later.
 */
function startKeepAlive(res, intervalMs = 15000) {
  return setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {
      /* ignore network errors (connection may be closed) */
    }
  }, intervalMs);
}

function stopKeepAlive(intervalId) {
  clearInterval(intervalId);
}

module.exports = {
  writeSseEvent,
  sendSseError,
  startKeepAlive,
  stopKeepAlive
}; 