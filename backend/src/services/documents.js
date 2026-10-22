/**
 * Shared helpers for the document-download endpoints and for every PDF upload
 * in the API.
 *
 * The uploaded PDF bytes are stored on the owning row itself (`data`, a
 * Postgres BYTEA / Prisma Bytes column, validated at upload time) and served
 * back through authenticated, ownership-scoped endpoints — there are no
 * public file URLs. List endpoints must never select the `data` column, so
 * the bytes ship only to callers that ask for one record by id.
 *
 * The multer instance, the size cap, the PDF gate and the stored-name helper
 * live here (not in a route file) because three separate surfaces upload PDFs —
 * employee documents, student documents and announcement attachments — and
 * they must agree on exactly what counts as an acceptable PDF.
 */
const multer = require('multer');
const { sendError } = require('../utils/response');

const DOCUMENT_MIME = 'application/pdf';

/** 5 MB cap — the same ceiling every upload in this API uses. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Multer keeps the upload in memory — no temp files to clean up. */
const documentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

/** Multer rejections (e.g. over the 5 MB cap) become a plain 400, not a 500. */
function documentUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    return sendError(
      res,
      err.code === 'LIMIT_FILE_SIZE' ? 'File too large — the maximum size is 5 MB' : 'File upload failed',
      400,
      'BAD_REQUEST'
    );
  }
  return next(err);
}

/**
 * Server-side PDF gate — the browser's `accept` filter is advisory, so an
 * upload is only accepted when the real extension, the declared MIME type and
 * the file's own `%PDF-` magic bytes all agree. A renamed .txt or a binary
 * blob with a .pdf name is rejected here.
 *
 * @returns {boolean} true when the request may continue; otherwise the error
 *   response has already been sent.
 */
function requirePdf(req, res) {
  if (!req.file) {
    sendError(res, 'No file uploaded — attach a PDF file', 400, 'BAD_REQUEST');
    return false;
  }
  const magic = req.file.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  if (!(/\.pdf$/i.test(req.file.originalname) && req.file.mimetype === DOCUMENT_MIME && magic)) {
    sendError(res, 'Only PDF files are allowed', 400, 'BAD_REQUEST');
    return false;
  }
  return true;
}

/**
 * PDF uploads for records where the file is OPTIONAL (announcement
 * attachments). Same magic-byte/MIME check as requirePdf, but a request with no
 * file at all is a valid text-only announcement rather than a 400.
 *
 * @returns {'absent'|'invalid'|'ok'}
 */
function checkOptionalPdf(req) {
  if (!req.file) return 'absent';
  const magic = req.file.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  return /\.(pdf)$/i.test(req.file.originalname) && req.file.mimetype === DOCUMENT_MIME && magic
    ? 'ok'
    : 'invalid';
}

/** Stored document name is derived from the actual uploaded file — never typed. */
function docNameFrom(file) {
  const base = file.originalname.replace(/\.[^.]*$/, '').trim();
  return (base || 'Document').slice(0, 200);
}

/**
 * Header-safe download name — strip anything that could break the
 * Content-Disposition header (control chars, non-ASCII, quotes, backslash)
 * the same way the stored name was derived from the uploaded file.
 */
const safeFileName = (fileName) =>
  String(fileName || 'document')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/["\\]/g, '')
    .trim()
    .slice(0, 200) || 'document';

/**
 * Serve a stored document as an attachment download.
 * `doc` must carry the validated bytes (`data`) and the stored `fileName`.
 * The stored name is normally extension-less (derived from the uploaded file
 * by the upload endpoints), but seeded/legacy records may carry a ".pdf" —
 * strip one trailing extension so the download never gets a doubled ".pdf.pdf".
 * Callers must answer metadata-only rows (`data === null`) with a 404 NO_FILE
 * before calling this.
 */
const sendDocumentPdf = (res, doc) => {
  const name = `${safeFileName(doc.fileName).replace(/\.pdf$/i, '')}.pdf`;
  res.setHeader('Content-Type', DOCUMENT_MIME);
  res.setHeader('Content-Length', doc.data.length);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(doc.data);
};

module.exports = {
  sendDocumentPdf,
  safeFileName,
  DOCUMENT_MIME,
  MAX_UPLOAD_BYTES,
  documentUpload,
  documentUploadError,
  requirePdf,
  checkOptionalPdf,
  docNameFrom,
};
