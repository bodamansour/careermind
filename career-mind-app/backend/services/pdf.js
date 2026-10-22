const multer = require('multer');
const { AppError } = require('./agents');

// 4 MB cap keeps uploads under Vercel's 4.5 MB function request body limit
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

async function extractPdfText(buffer) {
  // Check the magic bytes rather than trusting the browser-sent MIME type.
  if (!buffer || buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AppError('The uploaded file is not a PDF. Please upload your CV as a .pdf file.', 400);
  }

  let text;
  try {
    // unpdf is ESM-only and serverless-safe; loaded lazily so a PDF
    // library problem can never stop the rest of the API from starting.
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    ({ text } = await extractText(pdf, { mergePages: true }));
  } catch (err) {
    console.error('PDF parsing failed:', err.message);
    throw new AppError(
      'Could not read this PDF. It may be corrupted or password-protected — try exporting it again.',
      400
    );
  }

  const cvText = (text || '').trim();
  if (!cvText) {
    throw new AppError(
      'Could not extract any text from the PDF. Scanned/image-only CVs are not supported yet.',
      400
    );
  }
  return cvText.slice(0, 20000);
}

module.exports = { upload, extractPdfText };
