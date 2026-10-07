require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const analyzeRoutes = require('./routes/analyze');
const interviewRoutes = require('./routes/interview');
const jobsRoutes = require('./routes/jobs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api', analyzeRoutes);
app.use('/api/interview', interviewRoutes);
app.use('/api/jobs', jobsRoutes);

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// Return JSON (not an HTML page) for upload and other unhandled errors,
// since the frontend always reads the response as JSON.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'CV file is too large (max 4 MB).' });
  }
  console.error('unhandled error:', err && err.message);
  res.status(500).json({ error: 'Unexpected server error.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CareerMind AI running at http://localhost:${PORT}`);
});
