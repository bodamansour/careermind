require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const analyzeRoutes = require('./routes/analyze');
const interviewRoutes = require('./routes/interview');
const jobsRoutes = require('./routes/jobs');
const matchRoutes = require('./routes/match');
const { AGENTS, agentMode, missingAgents } = require('./services/agents');
const { rateLimit, envLimit } = require('./services/rateLimit');

const app = express();
// Vercel and Render sit one proxy in front of the app; trusting that hop makes
// req.ip the visitor's address (used by the rate limits below).
app.set('trust proxy', 1);

// The frontend is served by this same app, so the API only needs same-site
// calls. Other websites could otherwise make visitors' browsers spend this
// app's LLM credits. Extra sites can be allowed with ALLOWED_ORIGINS
// (comma-separated, e.g. https://my-site.com).
function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
}

app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (!origin) return next(); // same-origin GETs, curl, health checks
  let hostname = null;
  try {
    hostname = new URL(origin).hostname;
  } catch (_) {
    /* "null" or a malformed Origin */
  }
  if (hostname === req.hostname || allowedOrigins().includes(origin)) return next();
  res.status(403).json({ error: 'This API only accepts requests from the CareerMind app.' });
});
app.use(cors({ origin: (origin, callback) => callback(null, allowedOrigins().includes(origin)) }));
app.use(express.json({ limit: '2mb' }));

// Health check for Render / uptime monitors; also reports unconfigured agents.
app.get('/api/health', (req, res) => {
  const agents = {};
  Object.keys(AGENTS).forEach((key) => {
    agents[AGENTS[key].name] = agentMode(key) || 'not configured';
  });
  res.json({
    status: missingAgents().length ? 'degraded' : 'ok',
    agents,
    jobSearch: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
    matchApi: !!process.env.CAREERMIND_API_KEY,
  });
});

// Each of these calls spends LLM or API credits. Set a limit to 0 to disable it.
const HOUR = 60 * 60 * 1000;
app.use('/api/full-analysis', rateLimit({
  windowMs: HOUR,
  max: envLimit('RATE_LIMIT_ANALYSES_PER_HOUR', 10),
  message: 'Too many analyses from this connection. Please try again in an hour.',
}));
app.use('/api/interview', rateLimit({
  windowMs: HOUR,
  max: envLimit('RATE_LIMIT_INTERVIEW_MESSAGES_PER_HOUR', 100),
  message: 'Too many interview messages from this connection. Please try again later.',
}));
app.use('/api/jobs', rateLimit({
  windowMs: HOUR,
  max: envLimit('RATE_LIMIT_JOB_SEARCHES_PER_HOUR', 60),
  message: 'Too many job searches from this connection. Please try again later.',
}));

app.use('/api/match', rateLimit({
  windowMs: HOUR,
  max: envLimit('RATE_LIMIT_MATCHES_PER_HOUR', 120),
  message: 'Too many match requests. Please try again later.',
}));

app.use('/api/match', matchRoutes);
app.use('/api', analyzeRoutes);
app.use('/api/interview', interviewRoutes);
app.use('/api/jobs', jobsRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

// Serve the frontend (on Vercel, files in public/ are served by the CDN instead)
app.use(express.static(path.join(__dirname, 'public')));

// Return JSON (not an HTML page) for every error, since the frontend always
// reads the response as JSON.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'CV file is too large (max 4 MB).' });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request is too large.' });
  }

  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(`${req.method} ${req.originalUrl} failed:`, err.message);
  res.status(status).json({ error: status === 500 && !err.status ? 'Unexpected server error.' : err.message });
});

// Only listen when run directly (local / Render). Vercel imports the app instead.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`CareerMind AI running at http://localhost:${PORT}`);
    const missing = missingAgents();
    if (missing.length) {
      console.warn(
        'Warning: these agents are not configured yet:',
        missing.map((key) => AGENTS[key].name).join(', '),
        '— set OPENROUTER_API_KEY in .env'
      );
    }
  });
}

module.exports = app;
