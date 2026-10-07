const express = require('express');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const { callFlow, parseModelJSON } = require('../services/aimicromind');

const router = express.Router();
// 4 MB cap keeps uploads under Vercel's 4.5 MB function request body limit
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

router.post('/full-analysis', upload.single('cvFile'), async (req, res) => {
  try {
    const jdText = (req.body.jdText || '').trim();
    if (!req.file) return res.status(400).json({ error: 'No CV file uploaded.' });
    if (!jdText) return res.status(400).json({ error: 'Job description text is required.' });

    // 1. Extract text from the uploaded PDF
    const parser = new PDFParse({ data: req.file.buffer });
    let cvText;
    try {
      const pdfData = await parser.getText({ pageJoiner: '' });
      cvText = pdfData.text.trim();
    } finally {
      await parser.destroy();
    }
    if (!cvText) return res.status(400).json({ error: 'Could not extract any text from the PDF.' });

    // 2. CV Analyzer
    const cvRaw = await callFlow(process.env.CV_ANALYZER_URL, cvText);
    const cv = parseModelJSON(cvRaw);

    // 3. Job Analyzer
    const jobRaw = await callFlow(process.env.JOB_ANALYZER_URL, jdText);
    const job = parseModelJSON(jobRaw);

    // 4. Matching Agent
    const matchingQuestion = `CV_DATA:\n${JSON.stringify(cv)}\n\nJOB_DATA:\n${JSON.stringify(job)}`;
    const matchingRaw = await callFlow(process.env.MATCHING_URL, matchingQuestion);
    const matching = parseModelJSON(matchingRaw);

    // 5. Skill Gap Agent
    const skillGapQuestion =
      `missing_skills: ${JSON.stringify(matching.missing_skills || [])}\n` +
      `partial_match_skills: ${JSON.stringify(matching.partial_match_skills || [])}\n\n` +
      `JOB_DATA:\n${JSON.stringify(job)}`;
    const skillGapRaw = await callFlow(process.env.SKILLGAP_URL, skillGapQuestion);
    const skillGap = parseModelJSON(skillGapRaw);

    // 6. Roadmap Agent
    const roadmapRaw = await callFlow(process.env.ROADMAP_URL, JSON.stringify(skillGap));
    const roadmap = parseModelJSON(roadmapRaw);

    res.json({ cv, job, matching, skillGap, roadmap });
  } catch (err) {
    console.error('full-analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
