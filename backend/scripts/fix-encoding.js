#!/usr/bin/env node
/**
 * QA-A1-006/007/008/009 — repair double/triple-encoded text in the A1 source files.
 *
 * These files were saved through a chain of wrong encodings, so a plain UTF-8
 * character came to be stored as the bytes of its own mojibake — e.g. the rupee
 * sign `₹` (E2 82 B9) was stored as `Â‚¹` (C3 82 E2 80 9A C2 B9), the em-dash
 * `—` (E2 80 94) as `â€”` (C3 A2 E2 82 AC E2 80 9D), and studentForm.jsx carries
 * an even deeper level (`Γé╣` for `₹`).
 *
 * Guessing a decode depth per file is fragile, so this repairs by EXACT BYTE
 * MATCH: every known mojibake sequence is replaced by the character it should
 * be, and the buffer is re-saved as UTF-8. It is idempotent — it only matches
 * mangled bytes, never a correct character — so re-running it is a no-op once a
 * file is clean. It reports every replacement it makes.
 *
 * Usage: node scripts/fix-encoding.js
 */
const fs = require('node:fs');
const path = require('node:path');

/* The files in scope, relative to the repo root. */
const FILES = [
  'frontend/src/pages/admin/AdminStudents.jsx',
  'frontend/src/pages/admin/studentForm.jsx',
  'backend/src/services/fees.js',
  'backend/src/modules/fees/fees.routes.js',
  'backend/src/modules/admin/admin.routes.js',
];

/* The one-level-decode table: a mojibake sequence → the single character it
   stands for. The corrupted files carry MIXED depths (a token written twice over
   sits beside one written three times over), so the repair applies this table in
   a LOOP until nothing matches. Each pass peels exactly one encoding layer, and
   after enough passes every depth has been unwound. Every entry is a valid UTF-8
   byte sequence seen as latin1, so it can only match mangled bytes. */
const REPAIRS = [
  // one encoding layer
  ['c3a2e282ace2809d', '\u2014'], // â€”  → —
  ['c3a2e282ace28093', '\u2013'], // â€“  → –
  ['c3a2e282acc2a6', '\u2026'],   // â€¦  → …
  ['c3a2e282acc593', '\u201c'],   // â€œ  → “
  ['c3a2e282acc29d', '\u201d'],   // â€   → ”
  ['c3a2e2809ac2b9', '\u20b9'],   // â‚¹  → ₹
  ['c3a2e280a0e28099', '\u2192'], // â†’  → →
  ['c382c2b7', '\u00b7'],         // Â·   → ·
  // a "%s" over-decoded artefact: C2/C3 need the next layer to unwrap
  ['c3a2c280c294', '\u2014'],     // â\u0080\u0094 → —
  ['c3a2c280c293', '\u2013'],     // â\u0080\u0093 → –
];

/* Decode a hex string to the latin1 string that reproduces those exact bytes. */
const bytesToLatin1 = (hex) => Buffer.from(hex, 'hex').toString('latin1');

let total = 0;
for (const rel of FILES) {
  const abs = path.join(__dirname, '..', '..', rel);
  if (!fs.existsSync(abs)) { console.log(`skip (absent): ${rel}`); continue; }
  let s = fs.readFileSync(abs).toString('latin1'); // 1 char per byte — byte-exact
  let n = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = 0;
    for (const [hex, to] of REPAIRS) {
      const from = bytesToLatin1(hex);
      const count = s.split(from).length - 1;
      if (count) { s = s.split(from).join(to); changed += count; }
    }
    n += changed;
    if (changed === 0) break; // fixpoint reached
  }
  if (n === 0) { console.log(`unchanged: ${rel}`); continue; }
  fs.writeFileSync(abs, Buffer.from(s, 'utf8'));
  console.log(`repaired ${n} sequence(s): ${rel}`);
  total += n;
}
console.log(`Total replacements: ${total}`);
