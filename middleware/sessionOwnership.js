// middleware/sessionOwnership.js
//
// Chat sessions are addressed by a UUID that is not secret — it appears in
// workspace paths (/<user>/home/chats/<uuid>), GoWe labels and job metadata.
// Every route that reads or writes a session by id must therefore check that
// the authenticated user owns it; otherwise anyone who learns the id can read
// that chat, or plant messages that later run with the owner's token.
//
// Use requireSessionOwner AFTER requireAuth. A session id that does not exist
// yet is allowed through (new chats are created on their first turn).

const dbUtils = require('../services/dbUtils');

/**
 * True when a stored session user_id belongs to the authenticated user.
 * Mirrors resolveUserId: the token identity is realm-qualified
 * ("user@patricbrc.org"), while sessions written before the auth middleware
 * stored the bare username ("user").
 */
function isSameUser(ownerId, authUser) {
  if (typeof ownerId !== 'string' || typeof authUser !== 'string') return false;
  const owner = ownerId.trim().toLowerCase();
  const auth = authUser.trim().toLowerCase();
  if (!owner || !auth) return false;
  if (owner === auth) return true;
  return !owner.includes('@') && owner === auth.split('@')[0];
}

/**
 * Whether authUser may access sessionId. A nonexistent session is accessible
 * (it will be created as authUser's). Every stored copy must belong to them.
 */
async function canAccessSession(sessionId, authUser) {
  if (!authUser) return false;
  if (!sessionId) return true;
  const owners = await dbUtils.getSessionOwnerIds(sessionId);
  return owners.every((owner) => isSameUser(owner, authUser));
}

function sessionIdFromRequest(req) {
  return (req.params && req.params.sessionId) ||
    (req.body && req.body.session_id) ||
    (req.query && req.query.session_id) ||
    null;
}

function requireSessionOwner(req, res, next) {
  const sessionId = sessionIdFromRequest(req);
  if (sessionId !== null && typeof sessionId !== 'string') {
    return res.status(400).json({ message: 'session_id must be a string' });
  }
  canAccessSession(sessionId, req.user).then(
    (ok) => {
      if (ok) return next();
      return res.status(403).json({ message: 'Not authorized to access this session' });
    },
    (err) => {
      console.error('Session ownership check failed:', err.message || err);
      return res.status(500).json({ message: 'Failed to verify session ownership' });
    }
  );
}

module.exports = { requireSessionOwner, canAccessSession, isSameUser };
