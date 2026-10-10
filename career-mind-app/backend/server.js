require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const analyzeRoutes = require('./routes/analyze');
const interviewRoutes = require('./routes/interview');
const jobsRoutes = require('./routes/jobs');
const { AGENTS, missingAgents } = require('./services/aimicromind');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check for Render / uptime monitors; also reports unconfigured agents.
app.get('/api/health', (req, res) => {
  const missing = missingAgents().map((key) => AGENTS[key].env);
  res.json({
    status: missing.length ? 'degraded' : 'ok',
    missingConfig: missing,
    jobSearch: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
  });
});

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
        missing.map((key) => AGENTS[key].env).join(', ')
      );
    }
  });
}

module.exports = app;
