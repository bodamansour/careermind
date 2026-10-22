const express = require('express');
const { AppError } = require('../services/agents');
const engine = require('../services/engine');
const { upload, extractPdfText } = require('../services/pdf');

const router = express.Router();

const MAX_JD_LENGTH = 20000;

router.post('/full-analysis', upload.single('cvFile'), async (req, res, next) => {
  try {
    const jdText = (req.body.jdText || '').trim();
    if (!req.file) throw new AppError('No CV file uploaded.', 400);
    if (!jdText) throw new AppError('Job description text is required.', 400);
    if (jdText.length > MAX_JD_LENGTH) {
      throw new AppError(`Job description is too long (max ${MAX_JD_LENGTH} characters).`, 400);
    }

    // 1. Extract text from the uploaded PDF
    const cvText = await extractPdfText(req.file.buffer);

    // 2 + 3. CV Analyzer and Job Analyzer are independent, so run them in parallel
    const [cv, job] = await Promise.all([engine.analyzeCv(cvText), engine.analyzeJob(jdText)]);

    // 4. Matching Agent, then 5 + 6. Skill Gap and Roadmap agents
    const matching = await engine.match(cv, job);
    const { skillGap, roadmap } = await engine.plan(job, matching);

    res.json({ cv, job, matching, skillGap, roadmap });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
