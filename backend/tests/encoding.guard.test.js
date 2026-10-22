/**
 * Encoding guard — QA-A1-006/007/008/009.
 *
 * The repository was once saved through a wrong-encoding chain, turning a plain
 * `₹` into a run of mojibake characters, and in two files it left a stray UTF-8
 * BOM at byte 0 (a BOM before `/**` is a fatal JavaScript syntax error — the
 * backend would not start at all). This test is the tripwire: it fails if either
 * the garbled sequences or a BOM ever come back.
 *
 * ## Why the expected strings are built, not written
 *
 * This file must not CONTAIN the very bytes it forbids — a test that carries the
 * corruption would itself trip the guard (and could be "fixed" into passing by
 * an editor that mangles it). So every forbidden sequence is assembled at run
 * time from `\u` escapes describing code points, never typed literally.
 *
 * ## What is actually forbidden
 *
 * The end-user-visible bug was a corrupt currency symbol and em-dash. The general
 * signature is: a character's UTF-8 bytes each turned into their OWN character
 * (`₹` = E2 82 B9  →  U+00E2 U+0082 U+00B9), then re-saved as UTF-8. Anything
 * produced that way contains C1 control-range code points (U+0080–U+009F), which
 * never appear in legitimate source. We flag (a) any C1 control character and
 * (b) a BOM anywhere in a source file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* Roots to scan, relative to the backend package. */
const REPO_ROOT = path.join(__dirname, '..', '..');
const ROOTS = ['backend/src', 'backend/tests', 'backend/prisma', 'backend/scripts', 'frontend/src'];

const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.json', '.md', '.prisma', '.sql']);
const SKIP = /(^|[\\/])(node_modules|dist|build|coverage|\.next|\.git)([\\/]|$)/i;

/**
 * Files that legitimately contain the forbidden code points, with the reason.
 * Any addition here is a deliberate decision, not an accident.
 */
const ALLOWED = new Set([
  // The repair scripts carry the mangled sequences as a lookup table on purpose:
  // they must name what they are fixing. (Both are QA/migration tooling.)
  'backend/scripts/fix-encoding.js',
  'backend/scripts/fix-mojibake.js',
  // This guard builds the sequences from escapes, but keep the exemption explicit
  // so a future literal added here does not silently fail the suite.
  'backend/tests/encoding.guard.test.js',
]);

const isC1 = (ch) => ch >= 0x80 && ch <= 0x9f;

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (SKIP.test(abs)) continue;
    if (entry.isDirectory()) walk(abs, out);
    else if (EXTS.has(path.extname(entry.name).toLowerCase())) out.push(abs);
  }
  return out;
};

/** Every offending (kind, line, hex) in one file. */
const problemsIn = (abs) => {
  const problems = [];
  const raw = fs.readFileSync(abs, 'utf8');

  // (a) A BOM anywhere — start of file is fatal for JS.
  const bom = new String('\uFEFF');
  if (raw.includes(bom)) {
    const line = raw.slice(0, raw.indexOf(bom)).split('\n').length;
    problems.push({ kind: 'BOM (U+FEFF)', line, hex: 'efbbbf' });
  }

  // (b) any C1 control-range code point.
  raw.split('\n').forEach((ln, i) => {
    for (const ch of ln) {
      const cp = ch.codePointAt(0);
      if (isC1(cp)) {
        problems.push({ kind: 'mojibake (C1 control)', line: i + 1, hex: cp.toString(16).padStart(4, '0') });
      }
    }
  });
  return problems;
};

test('no source file contains mojibake (C1 control chars) or a BOM', () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const abs of walk(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const problems = problemsIn(abs);
      if (problems.length) {
        offenders.push(`${rel}  ::  ${problems.map((p) => `${p.kind}@${p.line}`).join(', ')}`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `Corrupt encoding found (fix QA-A1-006/007/008/009); run \`node backend/scripts/fix-mojibake.js --apply\`:\n${offenders.join('\n')}`,
  );
});

test('the guard actually detects a corrupt sample (its own tripwire)', () => {
  // Prove the detector is not vacuous: build a rupee mangled the exact way the
  // bug did — each UTF-8 byte of "\u20b9" turned into its own character.
  const rupee = String.fromCodePoint(0x20b9);
  const mangled = String.fromCodePoint(...Buffer.from(rupee, 'utf8')); // U+00E2 U+0082 U+00B9
  const found = [...mangled].some((ch) => isC1(ch.codePointAt(0)));
  assert.equal(found, true, 'the detector must flag a byte-per-character mangled rupee');

  // And that a correct rupee is NOT flagged.
  const clean = [...rupee].some((ch) => isC1(ch.codePointAt(0)));
  assert.equal(clean, false, 'a correct rupee must pass');
});
