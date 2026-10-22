/**
 * School-level settings — typed reads/writes over the generic `Setting`
 * key/value table (schema.prisma).
 *
 * The first setting is the weekly-off configuration: which weekday numbers the
 * school is closed. Every calendar and attendance calculation asks here, so
 * the school's real working week has exactly one definition and no screen can
 * hardcode a weekend again.
 */
const prisma = require('./prisma');

/** JS weekday numbers, 0 = Sunday … 6 = Saturday. The school's default is Sunday only. */
const DEFAULT_WEEKLY_OFF_DAYS = [0];

/** The Setting.key that holds the weekly-off array. */
const WEEKLY_OFF_KEY = 'weeklyOffDays';

/**
 * Keep only real weekday numbers, de-duplicate and sort. An empty array is a
 * meaningful value (a school that works all seven days), so it is preserved
 * rather than replaced by the default — only a non-array value falls back.
 */
const normalizeWeeklyOffDays = (value) => {
  if (!Array.isArray(value)) return [...DEFAULT_WEEKLY_OFF_DAYS];
  const days = value.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
};

/**
 * The stored weekly off days, defaulting to Sunday only when the row does not
 * exist yet (a fresh install before the setting is saved, or an older backup).
 * @returns {Promise<number[]>} e.g. [0] for Sunday, [] for no weekly off
 */
const getWeeklyOffDays = async () => {
  const row = await prisma.setting.findUnique({ where: { key: WEEKLY_OFF_KEY } });
  if (!row) return [...DEFAULT_WEEKLY_OFF_DAYS];
  return normalizeWeeklyOffDays(row.value);
};

/**
 * Persist the weekly off days and return the normalized value actually stored.
 * @param {number[]} days weekday numbers (0 = Sunday)
 */
const setWeeklyOffDays = async (days) => {
  const value = normalizeWeeklyOffDays(days);
  await prisma.setting.upsert({
    where: { key: WEEKLY_OFF_KEY },
    update: { value },
    create: { key: WEEKLY_OFF_KEY, value },
  });
  return value;
};

module.exports = {
  DEFAULT_WEEKLY_OFF_DAYS,
  WEEKLY_OFF_KEY,
  normalizeWeeklyOffDays,
  getWeeklyOffDays,
  setWeeklyOffDays,
};
