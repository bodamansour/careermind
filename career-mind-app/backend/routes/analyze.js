const express = require('express');
const multer = require('multer');
const { AppError, callFlowJSON } = require('../services/aimicromind');

const router = express.Router();
// 4 MB cap keeps uploads under Vercel's 4.5 MB function request body limit
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

const MAX_JD_LENGTH = 20000;

async function extractPdfText(buffer) {
  // Check the magic bytes rather than trusting the browser-sent MIME type.
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AppError('The uploaded file is not a PDF. Please upload your CV as a .pdf file.', 400);
  }

  try {
    // unpdf is ESM-only and serverless-safe; loaded lazily so a PDF
    // library problem can never stop the rest of the API from starting.
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return (text || '').trim();
  } catch (err) {
    console.error('PDF parsing failed:', err.message);
    throw new AppError(
      'Could not read this PDF. It may be corrupted or password-protected — try exporting it again.',
      400
    );
  }
}

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
    if (!cvText) {
      throw new AppError(
        'Could not extract any text from the PDF. Scanned/image-only CVs are not supported yet.',
        400
      );
    }

    // 2 + 3. CV Analyzer and Job Analyzer are independent, so run them in parallel
    const [cv, job] = await Promise.all([callFlowJSON('cv', cvText), callFlowJSON('job', jdText)]);

    // 4. Matching Agent
    const matching = await callFlowJSON(
      'matching',
      `CV_DATA:\n${JSON.stringify(cv)}\n\nJOB_DATA:\n${JSON.stringify(job)}`
    );

    // 5. Skill Gap Agent
    const skillGap = await callFlowJSON(
      'skillGap',
      `missing_skills: ${JSON.stringify(matching.missing_skills || [])}\n` +
        `partial_match_skills: ${JSON.stringify(matching.partial_match_skills || [])}\n\n` +
        `JOB_DATA:\n${JSON.stringify(job)}`
    );

    // 6. Roadmap Agent
    const roadmap = await callFlowJSON('roadmap', JSON.stringify(skillGap));

    res.json({ cv, job, matching, skillGap, roadmap });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
