/**
 * Client-side file download helper.
 * Docs/payslips are served via signed URLs in production; for the mock
 * prototype we generate a portable text file with the same content.
 */
export const downloadTextFile = (filename, content) => {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};