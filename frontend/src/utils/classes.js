/**
 * Class selector helpers.
 *
 * Class ids are database ids ('cls-10A'), so the options offered to an admin are
 * the classes returned by GET /school/options — never a local list — unioned with
 * any key already present in the page's payload so nothing that exists is hidden.
 */

/** 'cls-10A' → 'Class 10A' (readable fallback when the API has no label) */
const labelFromId = (id) => String(id).replace(/^cls-/, 'Class ');

/** Sort key: [grade, section] parsed out of a class id */
const sortKey = (id) => {
  const m = /^cls-(\d+)(.*)$/.exec(String(id));
  return m ? [Number(m[1]), m[2]] : [Number.MAX_SAFE_INTEGER, String(id)];
};

/**
 * Build the class options for a selector.
 * @param {string[]} keys class ids already referenced by the page's data
 * @param {Array<{id: string, label: string}>} classes classes from GET /school/options
 * @returns {Array<{id: string, label: string}>} options sorted by grade, then section
 */
export const classChoices = (keys, classes) => {
  const labels = new Map((classes || []).map((c) => [c.id, c.label]));
  const ids = [...new Set([...(classes || []).map((c) => c.id), ...(keys || [])])];
  return ids
    .map((id) => ({ id, label: labels.get(id) || labelFromId(id) }))
    .sort((a, b) => {
      const [ga, sa] = sortKey(a.id);
      const [gb, sb] = sortKey(b.id);
      return ga !== gb ? ga - gb : sa.localeCompare(sb);
    });
};