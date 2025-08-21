// services/sseUtils.js

/**
 * Send a Server-Sent-Events style error message and close the stream.
 */
function sendSseError(res, errorMsg) {
  try {
    res.write(`event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`);
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
  sendSseError,
  startKeepAlive,
  stopKeepAlive
}; 