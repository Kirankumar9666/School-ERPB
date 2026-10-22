#!/usr/bin/env node
/**
 * FINAL, generic mojibake repair (approved item #2).
 *
 * The files were saved through a chain of wrong encodings, so a run of
 * non-ASCII text may be mangled to MIXED depths and MIXED styles (some layers
 * interpreted as latin1/ISO-8859-1, some as CP1252). Hand-modelling each case
 * is what produced the earlier partial fixes, so this searches instead.
 *
 * For every maximal run of non-ASCII characters that contains a C1 control
 * code point (U+0080..U+009F) — the unmistakable signature of byte-per-char
 * mangling — it tries every combination of up to 4 inverse layers drawn from
 * {latin1, CP1252} and takes the first result that is clean text. The correct
 * character is whatever that clean result is.
 *
 * Safety:
 *  - dry-run by default; --apply writes.
 *  - only rewrites runs that contain a C1 code point, so correct UTF-8 is never
 *    touched and the operation is idempotent.
 *  - strips a leading BOM (raw or double-encoded) as well.
 *  - refuses files outside the repo.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const APPLY = process.argv.includes('--apply');

const CP1252_HIGH = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
  0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
  0x9E: '\u017E', 0x9F: '\u0178',
};
const CP1252_REV = new Map();
for (const [b, ch] of Object.entries(CP1252_HIGH)) CP1252_REV.set(ch, Number(b));

const isC1 = (ch) => ch.codePointAt(0) >= 0x80 && ch.codePointAt(0) <= 0x9f;
const hasC1 = (s) => [...s].some(isC1);

/** bytes of `s` interpreted as latin1 code points -> the original text. */
const invLatin1 = (s) => {
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xff) return null;
    bytes.push(cp);
  }
  return Buffer.from(bytes).toString('utf8');
};

/** bytes of `s` interpreted as CP1252 -> the original text. */
const invCp1252 = (s) => {
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) { bytes.push(cp); continue; }
    if (CP1252_REV.has(ch)) { bytes.push(CP1252_REV.get(ch)); continue; }
    return null;
  }
  return Buffer.from(bytes).toString('utf8');
};

const OPS = { L: invLatin1, W: invCp1252 };

/**
 * Direct replacements for mojibake that contains NO C1 control code point, so
 * the C1-driven search above cannot see it. Reading a correct `—` (bytes E2 80
 * 94) as CP1252 gives `â€”`, and that string saved as UTF-8 is real damage whose
 * characters are all printable — no U+0080..U+009F anywhere. Box-drawing rules
 * (`─`, U+2500) in comment banners are the common case here.
 *
 * Every `from` is produced by mangling the correct character through CP1252
 * (depth 1..3), or through latin1 at depth >= 2 (depth 1 latin1 is just the
 * correct UTF-8 bytes seen by a byte viewer, and must NOT be replaced). Because
 * each `from` is a mangled string and each `to` is a normal character, a correct
 * file never matches and the operation stays idempotent.
 */
const NON_C1_CHARS = [
  0x20b9, 0x2014, 0x2013, 0x2026, 0x201c, 0x201d, 0x2019, 0x2018, 0x00b7, 0x2192,
  0x2022, 0x00d7, 0x00b0, 0x00a0, 0x2500, 0x2502, 0x2713, 0x2714, 0x00bd, 0x00e9,
  0x2032, 0x2033, 0x2020, 0x2021, 0x203a, 0x2039, 0x2122, 0x20ac, 0x0153, 0x0161,
];

/** correct string -> the same string with its UTF-8 bytes read as CP1252. */
const mangleCp1252 = (s) => {
  let o = '';
  for (const b of Buffer.from(s, 'utf8')) {
    o += (b >= 0x80 && b <= 0x9f) ? (CP1252_HIGH[b] ?? String.fromCharCode(b)) : String.fromCharCode(b);
  }
  return o;
};

const NON_C1_FORMS = [];
for (const cp of NON_C1_CHARS) {
  const correct = String.fromCodePoint(cp);
  let s = correct;
  for (let d = 1; d <= 3; d += 1) {
    s = mangleCp1252(s);
    NON_C1_FORMS.push({ from: s, to: correct });
  }
  s = correct;
  for (let d = 1; d <= 3; d += 1) {
    s = Buffer.from(s, 'utf8').toString('latin1');
    if (d >= 2) NON_C1_FORMS.push({ from: s, to: correct });
  }
}

/**
 * Explicit repairs for the handful of runs that are NOT a clean single-layer
 * mangling — they are residues left by an earlier partial repair, so no
 * algorithm can invert them. Each entry was identified from the text around it
 * (e.g. `45000 <A> ₹45,000` is an arrow; `2026<B>27` is an en-dash range).
 * Keyed by the exact code-point sequence present in the file.
 */
const EXPLICIT = new Map();
for (const [cps, to] of [
  [[0x00C3, 0x00A2, 0x00E2, 0x0080, 0x00A0, 0x2019], '\u2192'], // arrow  (→)
  [[0x00C3, 0x00A2, 0x00E2, 0x0082, 0x00AC, 0x201C], '\u2013'], // en-dash (–)
  [[0x00C3, 0x0083, 0x00C2, 0x00A2, 0x00C3, 0x00A2, 0x00E2, 0x0080, 0x009A, 0x00C2, 0x00AC, 0x201D], '\u2014'], // em-dash (—)
  [[0x00C3, 0x0083, 0x00C2, 0x00A2, 0x00C3, 0x00A2, 0x00E2, 0x0080, 0x009A, 0x00C2, 0x00AC, 0x00C3, 0x0085, 0x201C], '\u201C'], // ldquo (“)
  [[0x00C3, 0x0083, 0x00C2, 0x00A2, 0x00C3, 0x00A2, 0x00E2, 0x0080, 0x009A, 0x00C2, 0x00AC, 0x00C3, 0x0082, 0x00C2, 0x009D], '\u201D'], // rdquo (”)
]) {
  EXPLICIT.set(String.fromCodePoint(...cps), to);
}

const decodeRun = (run) => {
  // 1. explicit residues from an earlier partial repair
  if (EXPLICIT.has(run)) return { result: EXPLICIT.get(run), path: 'explicit' };

  // 2. a clean whole-string inverse (handles single/double-layer mojibake such
  //    as `â€”` -> `—`), searching up to 4 L/W layers.
  const queue = [{ s: run, path: '' }];
  const seen = new Set([run]);
  while (queue.length) {
    const { s, path } = queue.shift();
    if (!hasC1(s) && !s.includes('\uFFFD')) return { result: s, path };
    if (path.length >= 4) continue;
    for (const [name, op] of Object.entries(OPS)) {
      const next = op(s);
      if (next === null || next === s || seen.has(next)) continue;
      seen.add(next);
      queue.push({ s: next, path: path + name });
    }
  }
  return null;
};

const SKIP = /(^|[\\/])(node_modules|\.git|dist|build|coverage|\.next)([\\/]|$)/i;
const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.html', '.css', '.prisma', '.sql', '.yml', '.yaml', '.txt']);
const SKIP_FILES = new Set([
  path.join(REPO_ROOT, 'backend', 'scripts', 'fix-encoding.js'),
  path.join(REPO_ROOT, 'backend', 'scripts', 'fix-mojibake.js'),
  path.join(REPO_ROOT, 'backend', 'tests', 'encoding.guard.test.js'),
]);

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (SKIP.test(abs)) continue;
    if (e.isDirectory()) walk(abs);
    else if (EXTS.has(path.extname(e.name).toLowerCase())) files.push(abs);
  }
};
walk(REPO_ROOT);

/** Repair non-ASCII runs in a single string. */
const repairText = (text) => {
  let changes = 0;

  // 0. whole-file replacements for mojibake with no C1 code point (e.g. the
  //    box-drawing rule `─`), which the run walker below cannot recognise.
  for (const { from, to } of NON_C1_FORMS) {
    if (!from || from === to) continue;
    const n = text.split(from).length - 1;
    if (n) { text = text.split(from).join(to); changes += n; }
  }

  let out = '';
  let i = 0;
  const chars = [...text];
  while (i < chars.length) {
    const cp = chars[i].codePointAt(0);
    if (cp <= 0x7f) { out += chars[i]; i += 1; continue; }
    // maximal run of non-ASCII
    let j = i;
    while (j < chars.length && chars[j].codePointAt(0) > 0x7f) j += 1;
    const run = chars.slice(i, j).join('');
    if (hasC1(run)) {
      const dec = decodeRun(run);
      if (dec) { out += dec.result; changes += 1; i = j; continue; }
    }
    out += run; i = j;
  }
  return { text: out, changes };
};

const report = [];
let totalFiles = 0, totalRuns = 0;
for (const abs of files) {
  if (!abs.startsWith(REPO_ROOT) || SKIP_FILES.has(abs)) continue;
  const before = fs.readFileSync(abs, 'utf8');
  let text = before;
  const { text: repaired, changes } = repairText(text);
  text = repaired;
  const details = changes ? [`runs x${changes}`] : [];
  // leading BOM (raw or double-encoded)
  if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); details.push('rawBOM'); }
  const dblBom = String.fromCodePoint(0x00ef, 0x00bb, 0x00bf);
  if (text.startsWith(dblBom)) { text = text.slice(dblBom.length); details.push('doubleBOM'); }

  if (text !== before) {
    totalFiles += 1; totalRuns += changes;
    report.push(`${path.relative(REPO_ROOT, abs)}  ::  ${details.join(', ')}`);
    if (APPLY) fs.writeFileSync(abs, Buffer.from(text, 'utf8'));
  }
}
console.log(report.join('\n'));
console.log(`\n== ${totalFiles} file(s), ${totalRuns} run(s) ${APPLY ? 'APPLIED' : '(dry-run)'} ==`);
