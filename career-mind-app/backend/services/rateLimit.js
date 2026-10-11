/**
 * Small in-memory rate limiter (fixed window, per client IP).
 *
 * Every analysis and interview turn spends LLM credits, so the public demo
 * caps how often one visitor can call them. Counts live in this process's
 * memory: on serverless hosts each warm instance keeps its own count, so this
 * stops bursts and scripted abuse rather than enforcing an exact global quota.
 *
 * @param {object} opts
 * @param {number} opts.windowMs - length of the window in milliseconds
 * @param {number} opts.max - requests allowed per IP per window (0 disables the limit)
 * @param {string} opts.message - error shown when the limit is reached
 * @param {() => number} [opts.now] - clock, for tests
 */
function rateLimit({ windowMs, max, message, now = Date.now }) {
  const hits = new Map(); // ip -> { count, resetAt }

  return function limiter(req, res, next) {
    if (!max) return next();

    const time = now();
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= time) {
      entry = { count: 0, resetAt: time + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    // Drop expired entries now and then so the map can't grow without bound.
    if (hits.size > 10000) {
      for (const [ip, e] of hits) if (e.resetAt <= time) hits.delete(ip);
    }

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - time) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

/** Reads a non-negative integer from an env variable, falling back to `fallback`. */
function envLimit(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

module.exports = { rateLimit, envLimit };
