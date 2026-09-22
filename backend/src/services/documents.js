/**
 * Shared helpers for the document-download endpoints.
 *
 * The uploaded PDF bytes are stored on the document row itself (`data`, a
 * Postgres BYTEA / Prisma Bytes column, validated at upload time) and served
 * back through authenticated, ownership-scoped endpoints — there are no
 * public file URLs. List endpoints must never select the `data` column, so
 * the bytes ship only to callers that ask for one document by id.
 */

const DOCUMENT_MIME = 'application/pdf';

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

module.exports = { sendDocumentPdf, safeFileName, DOCUMENT_MIME };
