/**
 * True when the buffer starts with the PDF signature ("%PDF-").
 * Checking the bytes (not the browser-reported MIME type) catches renamed
 * non-PDF files before they reach the PDF parser.
 */
function isPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Extracts plain text from a PDF buffer.
 * unpdf is ESM-only and serverless-safe; it is loaded lazily so a PDF
 * library problem can never stop the rest of the API from starting.
 */
async function extractPdfText(buffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text.trim();
}

module.exports = { isPdf, extractPdfText };
