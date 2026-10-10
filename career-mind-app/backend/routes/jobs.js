const express = require('express');
const axios = require('axios');
const { AppError } = require('../services/agents');

const router = express.Router();

// GET /api/jobs/search?q=AI Automation Engineer
router.get('/search', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) throw new AppError('Missing search query.', 400);
    if (query.length > 200) throw new AppError('Search query is too long.', 400);

    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    const country = (process.env.ADZUNA_COUNTRY || 'gb').toLowerCase(); // e.g. gb, us, in...

    if (!appId || !appKey) {
      throw new AppError(
        'Job search is not configured yet. Create a free account at developer.adzuna.com, ' +
          'then set ADZUNA_APP_ID and ADZUNA_APP_KEY.',
        503
      );
    }
    if (!/^[a-z]{2}$/.test(country)) {
      throw new AppError('ADZUNA_COUNTRY must be a two-letter country code such as gb or us.', 500);
    }

    let response;
    try {
      response = await axios.get(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`, {
        params: { app_id: appId, app_key: appKey, what: query, results_per_page: 10 },
        timeout: 15000,
      });
    } catch (err) {
      const status = err.response && err.response.status;
      console.error('Adzuna request failed:', status || err.code, err.message);
      if (status === 401 || status === 403) {
        throw new AppError('Job search credentials were rejected. Check ADZUNA_APP_ID / ADZUNA_APP_KEY.', 502);
      }
      throw new AppError('Could not fetch jobs right now. Try again shortly.', 502);
    }

    const jobs = (response.data.results || []).map((r) => ({
      title: r.title?.replace(/<[^>]+>/g, '') || 'Untitled role',
      company: r.company?.display_name || 'Unknown company',
      location: r.location?.display_name || '—',
      url: r.redirect_url,
    }));

    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
