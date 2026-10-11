const express = require('express');
const axios = require('axios');

const router = express.Router();

/** Keeps only http(s) links so a bad listing can't inject a javascript: URL. */
function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch (_) {
    return null;
  }
}

const stripTags = (value) => String(value).replace(/<[^>]+>/g, '').trim();

/** Maps one Adzuna search result to the shape the frontend renders. */
function mapAdzunaResult(r) {
  return {
    title: (r.title && stripTags(r.title)) || 'Untitled role',
    company: (r.company?.display_name && stripTags(r.company.display_name)) || 'Unknown company',
    location: (r.location?.display_name && stripTags(r.location.display_name)) || '—',
    url: safeUrl(r.redirect_url),
  };
}

// GET /api/jobs/search?q=AI Automation Engineer
router.get('/search', async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) return res.status(400).json({ error: 'Missing search query.' });

    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    const country = process.env.ADZUNA_COUNTRY || 'gb'; // e.g. gb, us, ae, in...

    if (!appId || !appKey) {
      return res.status(503).json({
        error:
          'Job search is not configured yet. Create a free account at developer.adzuna.com, ' +
          'then set ADZUNA_APP_ID and ADZUNA_APP_KEY in your .env file.',
      });
    }

    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1`;
    const response = await axios.get(url, {
      params: {
        app_id: appId,
        app_key: appKey,
        what: query,
        results_per_page: 10,
      },
      timeout: 15000,
    });

    const jobs = (response.data.results || []).map(mapAdzunaResult);

    res.json({ jobs });
  } catch (err) {
    console.error('jobs/search error:', err.message);
    res.status(500).json({ error: 'Could not fetch jobs right now. Try again shortly.' });
  }
});

module.exports = router;
module.exports.mapAdzunaResult = mapAdzunaResult;
