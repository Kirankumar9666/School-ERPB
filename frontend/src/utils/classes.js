/**
 * Class selector helpers.
 *
 * Class ids are database ids, and their GRADE IS NEVER PARSED OUT of them: a
 * named level's id ('cls-NURSERYA') has no grade to read, and extracting one
 * would be a guess. Every class option from GET /school/options carries the
 * level's `order`, which is the single shared sort — the same one
 * `compareClasses` uses on the server, and the same one promoted-by-order
 * depends on.
 *
 * Ids that predate the order field (a class already referenced by a page's own
 * payload) fall back to their label, exactly as before, and sort last rather
 * than breaking the whole list.
 */

/**
 * 'cls-NURSERYA' → 'Class NURSERYA' — a readable fallback only for an id that
 * arrived without a label. The server's `classLabel` is the real naming
 * function ("Nursery A"); this exists so a stale key never renders blank.
 */
const labelFromId = (id) => {
  const raw = String(id).replace(/^cls-/, '');
  // Named levels are stored upper-case and collapsed in the id; show them
  // spaced and titled instead of shouting.
  const spaced = raw.replace(/[0-9]+/g, (m) => ` ${m} `).replace(/([A-Z]+)/g, ' $1 ').replace(/\s+/g, ' ').trim();
  return spaced ? `Class ${spaced}` : `Class ${raw}`;
};

/** The shared sort key: level order first, then section. */
const sortKey = (cls) => [
  typeof cls.order === 'number' ? cls.order : Number.MAX_SAFE_INTEGER,
  String(cls.section || cls.label || cls.id),
];

/**
 * Build the class options for a selector.
 * @param {string[]} keys class ids already referenced by the page's data
 * @param {Array<{id: string, label: string, order?: number, section?: string}>} classes classes from GET /school/options
 * @returns {Array<{id: string, label: string}>} options sorted by level order, then section
 */
export const classChoices = (keys, classes) => {
  const byId = new Map((classes || []).map((c) => [c.id, c]));
  const ids = [...new Set([...(classes || []).map((c) => c.id), ...(keys || [])])];
  return ids
    .map((id) => {
      const known = byId.get(id);
      return { id, label: (known && known.label) || labelFromId(id) };
    })
    .sort((a, b) => {
      const [ka, sa] = sortKey(byId.get(a.id) || {});
      const [kb, sb] = sortKey(byId.get(b.id) || {});
      return ka !== kb ? ka - kb : sa.localeCompare(sb);
    });
};

/**
 * Display name for a class record, wherever one is already in hand.
 * Mirrors the server's `classLabel` — a numbered level reads "Class 10A" and a
 * named one "Nursery A". Used by the screens that hold a class object rather
 * than an option from the dropdown.
 */
export const displayClassLabel = ({ level, grade, section } = {}) => {
  if (!section) return null;
  const name = level ? level.name : (grade === null || grade === undefined ? null : String(grade));
  if (name === null) return `Class ${section}`;
  return /^\d+$/.test(name) ? `Class ${name}${section}` : `${name} ${section}`;
};
