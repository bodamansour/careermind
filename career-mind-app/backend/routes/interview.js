const express = require('express');
const { randomUUID } = require('crypto');
const { callFlow, parseModelJSON } = require('../services/aimicromind');

const router = express.Router();

// Start a new mock interview session
router.post('/start', async (req, res) => {
  try {
    const { cv, job } = req.body;
    if (!cv || !job) return res.status(400).json({ error: 'cv and job data are required.' });

    const sessionId = randomUUID();
    const question =
      `CV_DATA:\n${JSON.stringify(cv)}\n\n` +
      `JOB_DATA:\n${JSON.stringify(job)}\n\n` +
      `Start the interview.`;

    const reply = await callFlow(process.env.INTERVIEW_URL, question, sessionId);

    res.json({ sessionId, message: reply, isFinal: false });
  } catch (err) {
    console.error('interview/start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send the candidate's answer, get the next question (or the final evaluation)
router.post('/message', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required.' });
    }

    const reply = await callFlow(process.env.INTERVIEW_URL, message, sessionId);

    // The agent's final message is a JSON evaluation. Detect it by trying to parse it.
    let evaluation = null;
    try {
      const parsed = parseModelJSON(reply);
      if (parsed && typeof parsed.overall_score === 'number') {
        evaluation = parsed;
      }
    } catch (_) {
      /* not the final JSON yet - just a normal question/feedback message */
    }

    res.json({
      message: evaluation ? null : reply,
      isFinal: !!evaluation,
      evaluation,
    });
  } catch (err) {
    console.error('interview/message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
