const crypto = require('crypto');
const { AppError } = require('./agents');
const { db } = require('./db');

/** Express middleware: requires a signed-in user (Supabase access token). */
async function requireUser(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new AppError('Sign in first.', 401);

    const { data, error } = await db().auth.getUser(token);
    if (error || !data?.user) throw new AppError('Your session has expired. Sign in again.', 401);

    req.user = { id: data.user.id, email: data.user.email };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Express middleware for server-to-server calls (the n8n automations).
 * Needs the shared CAREERMIND_API_KEY in the x-api-key header.
 */
function requireApiKey(req, res, next) {
  const expected = process.env.CAREERMIND_API_KEY || '';
  if (!expected) {
    return next(new AppError('The automation API is not enabled. Set CAREERMIND_API_KEY on the server.', 503));
  }
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return next(new AppError('Missing or wrong x-api-key header.', 401));
  }
  next();
}

module.exports = { requireUser, requireApiKey };
