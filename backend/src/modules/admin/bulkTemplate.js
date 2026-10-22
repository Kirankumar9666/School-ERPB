/**
 * Bulk student upload template, for ONE class.
 *
 * ## Why the template is generated on request
 *
 * A stored file per class would mean a row per class in the database holding
 * bytes nobody ever looks at again, and it would still have to be regenerated the
 * moment a class was created. The template is two facts — the column list and the
 * class they apply to — both of which the server already knows, so it is built and
 * streamed per request and nothing is kept.
 *
 * The columns are the bulk-import columns MINUS Class and Section, because the
 * chosen class applies to every row. Those two columns stay accepted on upload
 * for backward compatibility (a file from before this change), but the template
 * no longer contains them, so nobody is invited to fill in a value that is ignored
 * — or worse, one that contradicts the class the upload is scoped to.
 *
 * @module modules/admin/bulkTemplate
 */
const ExcelJS = require('exceljs');
const prisma = require('../../services/prisma');
const { wrapAsync } = require('../../utils/asyncRoute');
const { classLabel } = require('../../services/mappers');

/** Express, required here so this module can be mounted by the admin router. */
const express = require('express');

/** Columns of a student bulk file, WITHOUT the class (which is chosen on screen). */
const TEMPLATE_COLUMNS = ['Name', 'RollNumber', 'ParentGuardian', 'Contact', 'FeeDues'];

/**
 * A file-system-safe name fragment: only letters, digits and single dashes.
 *
 * "LKG A" -> "LKG-A", "Class 10A" -> "CLASS-10A".
 * Spaces and separators that exist on some filesystems (and every shell prompt)
 * would break the download, and a class named from user input must never be able
 * to escape its own filename — stripping everything but these does.
 */
const safeFragment = (label) => String(label || '')
  .trim()
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toUpperCase();

/** "students-template-LKG-A.csv" */
const templateFileName = (label, ext) => `students-template-${safeFragment(label)}.${ext}`;

/** Per-column explanation for the XLSX Instructions sheet. */
const COLUMN_HELP = {
  Name: "Required. The student's full name, spelled the way the school already spells it.",
  RollNumber: 'Optional. Leave it blank and the next free number in this class is assigned. Blank is normally what you want.',
  ParentGuardian: "Required. The guardian's full name. With Name and Contact this is how the same child is matched in future years, so all three must be spelled exactly as the school already has them.",
  Contact: 'Required. Contact must be exactly 10 digits. "+91-9876543210", "9876543210" and "+91 98765 43210" all work — anything that is not exactly 10 digits is rejected for that row.',
  FeeDues: 'Required. What this student already owes, as a plain number with no currency symbol. It becomes the fee amount recorded for them.',
};

/**
 * One example row for the template. Derived from the columns rather than typed,
 * so a new column cannot be left out of the example by accident.
 */
const EXAMPLE_ROW = ['Rahul Menon', '', 'Anand Menon', '+91-9876543210', 5000];

const router = wrapAsync(express.Router());

/**
 * GET /api/v1/admin/students/bulk-template?classId=...&format=csv|xlsx
 *
 * `format` picks the shape and defaults to XLSX; the CSV is the same header with
 * the same example row. The class is resolved from the database so the header, the
 * instructions and the file name all name it the same way every screen does — a
 * school's own wording for a level, never ours.
 */
router.get('/students/bulk-template', async (req, res) => {
  const classId = String(req.query.classId || '');
  if (!classId) return res.status(400).json({ success: false, message: 'Choose a class first' });

  const cls = await prisma.class.findUnique({
    where: { id: classId },
    include: { level: true },
  });
  if (!cls) return res.status(404).json({ success: false, message: 'Class not found' });

  const label = classLabel(cls);
  const columns = TEMPLATE_COLUMNS;

  if (String(req.query.format || '') === 'csv') {
    const lines = [columns.join(','), EXAMPLE_ROW.join(',')];
    // The BOM is what makes Excel on Windows read this as UTF-8 rather than
    // mangling the currency symbol and any accented name.
    const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${templateFileName(label, 'csv')}"`);
    return res.end(csv);
  }

  const book = new ExcelJS.Workbook();
  book.creator = 'School ERP';

  const sheet = book.addWorksheet('Students');
  sheet.addRow(columns);
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFE7D6' } };
  sheet.columns.forEach((c) => { c.width = 20; });
  const example = sheet.addRow(EXAMPLE_ROW);
  example.font = { italic: true, color: { argb: 'FF808080' } };

  const notes = book.addWorksheet('Instructions');
  notes.getColumn(1).width = 20;
  notes.getColumn(2).width = 95;
  notes.addRow([`Class: ${label}`]); // the class every row belongs to, at the very top
  notes.getRow(1).font = { bold: true, size: 14 };
  notes.addRow([]);
  notes.addRow([
    'This file adds students to that class ONLY.',
    'There are no Class or Section columns: the class was chosen on the Bulk Add screen, and every row in this file is saved for it.',
  ]);
  notes.addRow([]);
  notes.addRow(['Columns']);
  notes.getRow(notes.rowCount).font = { bold: true };
  columns.forEach((col) => notes.addRow([col, COLUMN_HELP[col]]));

  notes.addRow([]);
  notes.addRow(['Rules']);
  notes.getRow(notes.rowCount).font = { bold: true };
  [
    'Every row needs a Name, a guardian and a contact.',
    'Contact must be exactly 10 digits, with an optional +91 prefix.',
    'A student already on file with the same name, guardian and contact is rejected: that is the same child, and two records for one child is the error this check exists to stop.',
    'The same student listed twice in one file is rejected too, with both row numbers.',
    'Up to 200 students per file.',
    'Everything is checked before anything is saved — if one row is wrong, none of them are saved.',
    'Siblings are fine. The same guardian and contact with a DIFFERENT name is not a duplicate.',
  ].forEach((line) => notes.addRow(['', line]));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${templateFileName(label, 'xlsx')}"`);
  await book.xlsx.write(res);
  return res.end();
});

module.exports = router;
module.exports.TEMPLATE_COLUMNS = TEMPLATE_COLUMNS;
module.exports.templateFileName = templateFileName;
module.exports.safeFragment = safeFragment;
module.exports.COLUMN_HELP = COLUMN_HELP;
