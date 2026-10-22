/**
 * Classes and grade levels — the one place a class is created, renamed or sorted.
 *
 * ## What lives here and why
 *
 * `Class.grade` holds the level's ORDER, not a level name. That is a deliberate
 * denormalisation: the migration added named levels (Nursery, LKG, UKG) below the
 * numbered ones, and giving the pre-primary levels negative orders means an
 * existing Class 5A keeps grade 5 — its id, students, attendance, marks, fees and
 * enrollments are all untouched, and every existing index, sort and query keeps
 * working exactly as before.
 *
 * The consequence is that the two must be kept in step, and THIS is the only
 * module allowed to move either: `setLevelOrder` updates every class of a level
 * in the same transaction as the level row. A caller that wrote `grade` directly
 * would leave the sort wrong for one class and the class list lying about it.
 *
 * ## Ids are opaque
 *
 * A class id is never parsed for its grade or section — 'cls-10A' and
 * 'cls-NURSERYA' are both just keys, and both are read back off the class record.
 * See `levelSlug` in mappers.js for how they are formed.
 *
 * @module services/classes
 */
const prisma = require('./prisma');
const { classIdOf, classLabel, compareClasses, levelSlug } = require('./mappers');

/** Levels, in teaching order. The shape every screen receives. */
const listLevels = async () => prisma.gradeLevel.findMany({ orderBy: { order: 'asc' } });

/**
 * Every class, with its level, sorted by the ONE shared comparator.
 *
 * `orderBy: { grade }` is correct because `grade` is defined to be the level's
 * order — and the comment on `compareClasses` explains why that cannot drift.
 */
const listClasses = async ({ includeLevel = true } = {}) => {
  const rows = await prisma.class.findMany({
    ...(includeLevel ? { include: { level: true } } : {}),
    orderBy: [{ grade: 'asc' }, { section: 'asc' }],
  });
  return includeLevel ? [...rows].sort(compareClasses) : rows;
};

/**
 * Add a level.
 *
 * `afterId` says where it goes: the new level takes the order immediately after
 * the named one. Levels are stored contiguously, so inserting has to make room —
 * which is done in one transaction, renumbering everything below it by the same
 * step. A partially-renumbered order list would sort two levels into the same
 * place, so the whole move is atomic or none of it happens.
 *
 * @param {{name: string, afterId?: string|null}} input
 * @returns the created level
 */
const createLevel = async ({ name, afterId = null }) => {
  const trimmed = String(name || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) throw Object.assign(new Error('Name the level'), { code: 'MISSING_NAME' });

  return prisma.$transaction(async (tx) => {
    const levels = await tx.gradeLevel.findMany({ orderBy: { order: 'asc' } });

    const clash = levels.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
    if (clash) {
      throw Object.assign(new Error(`Level "${clash.name}" already exists`), {
        code: 'DUPLICATE_LEVEL',
        existing: clash,
      });
    }

    // Default: append at the end, unless a specific level was named.
    const at = afterId ? levels.findIndex((l) => l.id === afterId) : -1;
    const newOrder = at === -1
      ? (levels.length ? levels[levels.length - 1].order + 1 : 0)
      : levels[at].order + 1;

    // Make room, then insert. Renumber from the bottom up so no two rows collide
    // on the unique order index mid-transaction.
    if (at !== -1) {
      const below = levels.slice(at + 1);
      for (const level of [...below].reverse()) {
        await tx.gradeLevel.update({ where: { id: level.id }, data: { order: level.order + 1 } });
      }
    }

    const level = await tx.gradeLevel.create({
      data: { id: `gl-${levelSlug(trimmed)}`, name: trimmed, order: newOrder },
    });

    // Re-sync every class of the moved levels in the SAME transaction, so no
    // observer can see an order that disagrees with a class's grade.
    await syncGrades(tx);
    return level;
  }, { timeout: 30000, maxWait: 10000 });
};

/**
 * Push `Class.grade` back into agreement with the level's order.
 *
 * Only the classes whose grade actually differs are written, so the common case
 * (adding a level at the end) touches nothing.
 *
 * The writes go HIGHEST-NEW-GRADE-FIRST, and that order is the whole reason the
 * function looks the way it does. Every class of a shifted level moves by the
 * same delta, so a row whose NEW grade equals another row's OLD grade would
 * collide on the unique (grade, section) index if the lower one moved first:
 * Class 5A to 6 while Class 6A is still sitting there. Working down from the top
 * vacates each slot before the row below needs it, which is the only order that
 * is safe inside a unique index.
 */
const syncGrades = async (client) => {
  const classes = await client.class.findMany({
    where: { levelId: { not: null } },
    include: { level: true },
  });
  const stale = classes.filter((c) => c.level && c.grade !== c.level.order);
  if (!stale.length) return 0;

  /*
   * The write ORDER depends on the direction of the move, and this is the whole
   * reason the function is not a one-liner.
   *
   * Every class of a shifted level moves by the SAME delta, so a row's new grade
   * is another row's old grade. Both directions therefore collide on the unique
   * (grade, section) index unless the vacated slot is filled last:
   *
   *   moving UP   (a level was inserted above) — work from the HIGHEST new grade
   *               down, so Class 6A moves to 7 before Class 5A moves to 6.
   *   moving DOWN (a level was deleted)       — work from the LOWEST new grade
   *               up, so Class 5A moves to 5 before Class 6A moves to 6.
   *
   * Getting this backwards is a P2002 halfway through, which in an untransactional
   * caller leaves the levels renumbered and the classes not — a sort order that no
   * longer means anything.
   */
  const delta = stale[0].level.order - stale[0].grade;
  const ascending = delta < 0;
  stale.sort((a, b) => (ascending ? a.level.order - b.level.order : b.level.order - a.level.order));

  for (const cls of stale) {
    await client.class.update({ where: { id: cls.id }, data: { grade: cls.level.order } });
  }
  return stale.length;
};

/**
 * Create a class for one level and section.
 *
 * The level must already exist — a class is never created by guessing a grade
 * from a typed number, which is how a named level would end up with an id that
 * has no meaning.
 *
 * @param {{levelId: string, section: string}} input
 * @returns {{cls: object, created: boolean}} `created` false when it already existed
 */
const createClass = async ({ levelId, section }) => {
  const letter = String(section || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(letter)) {
    throw Object.assign(new Error('Section must be 1–3 letters'), { code: 'BAD_SECTION' });
  }

  return prisma.$transaction(async (tx) => {
    const level = await tx.gradeLevel.findUnique({ where: { id: levelId } });
    if (!level) throw Object.assign(new Error('Level not found'), { code: 'NOT_FOUND' });

    const id = classIdOf(level.name, letter);
    const existing = await tx.class.findUnique({ where: { id } });
    if (existing) {
      return { cls: existing, created: false, label: classLabel({ ...existing, level }) };
    }

    const cls = await tx.class.create({
      data: {
        id,
        // grade carries the level's order — that is the whole design; see the
        // module comment.
        grade: level.order,
        section: letter,
        levelId: level.id,
      },
    });
    return { cls, created: true, label: classLabel({ ...cls, level }) };
  }, { timeout: 30000, maxWait: 10000 });
};

/**
 * Rename a level.
 *
 * Class ids are NOT rebuilt: they are opaque keys and rewriting them would have
 * to cascade through every reference in the database for a cosmetic gain. The
 * label comes from the level's name, so a rename shows everywhere at once.
 */
const renameLevel = async ({ levelId, name }) => {
  const trimmed = String(name || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) throw Object.assign(new Error('Name the level'), { code: 'MISSING_NAME' });

  return prisma.$transaction(async (tx) => {
    const clash = await tx.gradeLevel.findFirst({
      where: { name: { equals: trimmed, mode: 'insensitive' }, id: { not: levelId } },
    });
    if (clash) {
      throw Object.assign(new Error(`Level "${clash.name}" already exists`), {
        code: 'DUPLICATE_LEVEL',
        existing: clash,
      });
    }
    return tx.gradeLevel.update({ where: { id: levelId }, data: { name: trimmed } });
  }, { timeout: 30000, maxWait: 10000 });
};

/**
 * Delete a level — refused while any class still points at it.
 *
 * A level with classes is not a delete, it is an archive decision the office has
 * to make explicitly, so the error names how many classes are in the way.
 */
const deleteLevel = async ({ levelId }) => prisma.$transaction(async (tx) => {
  const level = await tx.gradeLevel.findUnique({
    where: { id: levelId },
    include: { _count: { select: { classes: true } } },
  });
  if (!level) throw Object.assign(new Error('Level not found'), { code: 'NOT_FOUND' });
  if (level._count.classes > 0) {
    throw Object.assign(
      new Error(`${level.name} still has ${level._count.classes} class${level._count.classes === 1 ? '' : 'es'} — delete those first`),
      { code: 'LEVEL_HAS_CLASSES', count: level._count.classes },
    );
  }

  /* Closing the gap left behind: everything BELOW the removed level moves down one
     — the mirror image of createLevel. Levels first, ASCENDING, because each slot
     it needs has just been vacated by the one below it; then the classes of the
     moved levels, in the same direction. Both happen inside this transaction, so a
     failure halfway through cannot leave the levels renumbered while the classes
     still point at grades that no longer belong to them. */
  const removedOrder = level.order;
  await tx.gradeLevel.delete({ where: { id: levelId } });

  const below = await tx.gradeLevel.findMany({
    where: { order: { gt: removedOrder } },
    orderBy: { order: 'asc' },
  });
  for (const l of below) {
    await tx.gradeLevel.update({ where: { id: l.id }, data: { order: l.order - 1 } });
  }

  await syncGrades(tx);
  return level;
}, { timeout: 30000, maxWait: 10000 });

/**
 * Match a typed legacy class value ('lkg', 'Class 5', '5') against the levels.
 *
 * Only the LEGACY bulk file may carry a typed class — see
 * `matchLegacyLevel`. Everything else selects from the shared class list.
 *
 * @param {string} raw whatever the cell held
 * @returns {object|null} the matching level, or null
 */
const matchLevel = async (raw) => {
  const wanted = String(raw ?? '')
    .trim()
    .replace(/^class\s+/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!wanted) return null;
  const levels = await listLevels();
  return levels.find((l) => l.name.toLowerCase() === wanted) || null;
};

/**
 * The next class in the promotion chain, or null when the chain ends.
 *
 * The next class is the next LEVEL in the order list, with the SAME section, so
 * Nursery A promotes to LKG A, LKG A to UKG A, UKG A to Class 1 A. Nothing is
 * derived from the order number: adding a level between two others shifts every
 * order below it, and a grade+1 rule would silently promote a student into a level
 * that no longer exists — or past one that was just inserted above them.
 *
 * @param {string} classId the class to promote out of
 * @param {{client?: object, create?: boolean}} [options]
 *   `client` runs inside a transaction. `create` (default true) controls whether
 *   a missing destination class is INSERTED. Read/preview callers pass
 *   `create: false` so merely opening a review cannot leave an orphan class
 *   behind (QA-A1-017); the write path keeps the default and creates it inside
 *   the same transaction as the promotion.
 * @returns {Promise<{classId: string, label: string, willBeCreated: boolean}|null>}
 */
const nextClassFor = async (classId, { client, create = true } = {}) => {
  const db = client || prisma;
  const cls = await db.class.findUnique({ where: { id: classId }, include: { level: true } });
  if (!cls) throw Object.assign(new Error('Class not found'), { code: 'NOT_FOUND' });
  if (!cls.level) {
    // No level linked: there is no chain to follow. Refused by the caller with
    // an actionable message rather than guessed at.
    return null;
  }

  const nextLevel = await db.gradeLevel.findFirst({
    where: { order: { gt: cls.level.order } },
    orderBy: { order: 'asc' },
  });
  if (!nextLevel) return null;

  const targetId = classIdOf(nextLevel.name, cls.section);
  const existing = await db.class.findUnique({ where: { id: targetId }, select: { id: true } });
  const willBeCreated = !existing;
  // Created on demand so the write path can rely on it existing AFTER a confirmed
  // promotion. A read/preview caller sets `create: false` and only learns the id
  // and `willBeCreated` — nothing is written.
  if (willBeCreated && create) {
    await db.class.create({
      data: { id: targetId, grade: nextLevel.order, section: cls.section, levelId: nextLevel.id },
    });
  }
  return {
    classId: targetId,
    label: classLabel({ grade: nextLevel.order, section: cls.section, level: nextLevel }),
    levelId: nextLevel.id,
    levelName: nextLevel.name,
    order: nextLevel.order,
    willBeCreated,
  };
};

/**
 * The class a student is in, as a label-free id, PLUS its level. Used by the
 * "Keep in same class" path, which is the one promotion action that must not move
 * — so it reads the level rather than computing a target.
 */
const classLevel = async (classId, client) => {
  const db = client || prisma;
  const cls = await db.class.findUnique({ where: { id: classId }, include: { level: true } });
  return cls || null;
};
module.exports = {
  listLevels,
  listClasses,
  createClass,
  createLevel,
  renameLevel,
  deleteLevel,
  syncGrades,
  matchLevel,
  nextClassFor,
  classLevel,
};
