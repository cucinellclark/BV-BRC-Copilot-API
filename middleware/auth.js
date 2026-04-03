const ValidateToken = require('p3-user/validateToken')
const config = require('../config.json')
const signingSubjectURL = config['signingSubjectURL']

/**
 * requireAuth - Blocking authentication middleware.
 *
 * Validates the BV-BRC JWT token from the Authorization header.
 * If the token is missing or invalid the request is rejected with 401.
 * On success, sets:
 *   req.user      – the validated user ID (e.g. "user@patricbrc.org")
 *   req.authToken – the raw Authorization header value (for downstream use)
 *
 * Use this on every endpoint that accesses user data or performs actions
 * on behalf of a user.
 */
function requireAuth(req, res, next) {
  if (!signingSubjectURL) {
    return next(new Error('Missing signingSubjectURL in config'))
  }

  // If already authenticated by an upstream layer (e.g. passport), pass through
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next()
  }

  const authHeader = req.headers && req.headers['authorization']

  if (!authHeader) {
    return res.status(401).json({ message: 'Authentication required. Provide a valid Authorization header.' })
  }

  ValidateToken(authHeader, signingSubjectURL)
    .then((valid) => {
      if (valid && valid.id) {
        req.user = valid.id
        req.authToken = authHeader
        next()
      } else {
        return res.status(401).json({ message: 'Invalid or expired authentication token.' })
      }
    })
    .catch((err) => {
      console.error('Token validation error:', err.message || err)
      return res.status(401).json({ message: 'Authentication token validation failed.' })
    })
}

/**
 * optionalAuth - Permissive authentication middleware.
 *
 * Attempts to validate the token if an Authorization header is present.
 * Sets req.user and req.authToken on success but never rejects the request.
 * Use this only for genuinely public endpoints (health probes, test, etc.)
 * where authentication is nice-to-have but not required.
 */
function optionalAuth(req, res, next) {
  if (!signingSubjectURL) {
    return next(new Error('Missing signingSubjectURL in config'))
  }

  if (req.isAuthenticated && req.isAuthenticated()) {
    return next()
  }

  const authHeader = req.headers && req.headers['authorization']

  if (!authHeader) {
    return next()
  }

  ValidateToken(authHeader, signingSubjectURL)
    .then((valid) => {
      if (valid && valid.id) {
        req.user = valid.id
        req.authToken = authHeader
      }
      next()
    })
    .catch((err) => {
      console.error('Optional token validation failed:', err.message || err)
      next()
    })
}

/**
 * resolveUserId - Validates and resolves the user identity for an endpoint.
 *
 * Uses the authenticated identity from req.user (set by requireAuth) as the
 * authoritative user ID. If a client-supplied user_id is provided, it is
 * validated against the token identity:
 *   - If they match, the request proceeds normally.
 *   - If they differ, the request is rejected with 403.
 *   - If no client user_id is supplied, req.user is used.
 *
 * @param {object} req  - Express request (must have req.user set by requireAuth)
 * @param {string|null|undefined} suppliedUserId - user_id from req.body or req.query
 * @returns {{ userId: string } | { error: string, status: number }}
 */
function resolveUserId(req, suppliedUserId) {
  const authenticatedUser = req.user

  if (!authenticatedUser) {
    return { error: 'Authentication required.', status: 401 }
  }

  if (suppliedUserId && typeof suppliedUserId === 'string') {
    const trimmed = suppliedUserId.trim()
    if (trimmed && trimmed !== authenticatedUser) {
      return {
        error: 'Forbidden: supplied user_id does not match the authenticated user.',
        status: 403
      }
    }
  }

  return { userId: authenticatedUser }
}

module.exports = { requireAuth, optionalAuth, resolveUserId }
