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
 * The school's final level, or null when none is set.
 *
 * ONE read for a fact four places used to derive. A null answer is not an error:
 * it means the school has not set a final class yet, and every caller must then
 * fall back to the behaviour it had before this column existed. Returning null
 * rather than throwing is what keeps "nothing is marked final" a working state
 * instead of a broken one.
 *
 * @param {object} [client] a transaction handle, so a promotion reads the same
 *        snapshot its writes act on
 */
const finalLevel = async (client = null) => {
  const db = client || prisma;
  return db.gradeLevel.findFirst({ where: { isFinal: true } });
};

/**
 * Is this level (by order) the school's final class?
 *
 * The single predicate behind `isTop` on every surface, so the overview, the
 * promote guard, the target resolver and the roster cannot disagree. When no
 * level is final it answers `false` for everything — which is what makes the
 * no-flag case preserve today's behaviour exactly: callers apply their own
 * derived fallback only when `hasFinalLevel()` is false.
 */
const isFinalOrder = async (order, client = null) => {
  const level = await finalLevel(client);
  return Boolean(level) && level.order === order;
};

/** Whether the school has set a final class at all. */
const hasFinalLevel = async (client = null) => Boolean(await finalLevel(client));

/**
 * Refuse a level/class that sits ABOVE the school's final class unless the caller
 * explicitly opted in.
 *
 * ## Why above-final creation stays possible at all
 *
 * A school genuinely plans Class 11 in April while Class 10 is still its final
 * year until the term ends: the level must be creatable BEFORE the office is
 * ready to say 10 has graduated. So this is not a ban — it is a deliberate,
 * recorded act. The caller sends `allowAboveFinal: true` and proceeds; without it
 * the write is refused ONCE with `ABOVE_FINAL_CONFIRM`, the admin is told the new
 * level sits above the final class, and nothing is written.
 *
 * The shape mirrors `deleteLevel`'s FINAL_LEVEL_CONFIRM exactly: refuse once with
 * a distinguishable code, let the caller re-ask with the flag. One confirm
 * pattern in the codebase, not two.
 *
 * ## Nothing to check when no final class is set
 *
 * No flag means no above — every level is legitimate. Returns without a read
 * beyond the flag itself, so the common case costs one query.
 *
 * ## A class on a level that is ALREADY above the final
 *
 * Reuses the same opt-in each time (see the caller's note in `createClass`): the
 * check is on the CLASS's level order, not on whether the level was added
 * earlier, so re-opening a section of an above-final level asks again. The
 * alternative — remembering that a level was once created above the final and
 * exempting its classes forever — would let a later admin silently fill an
 * above-final level with no record that anyone decided to. Asking again is the
 * price of a decision that stays visible.
 *
 * @param {object} db a transaction handle (the caller already holds one)
 * @param {{order: number, label: string}} target the level/class being created
 * @param {boolean} allowAboveFinal the caller's explicit opt-in
 */
const assertNotAboveFinal = async (db, { order, label }, allowAboveFinal) => {
  if (allowAboveFinal) return;
  const final = await finalLevel(db);
  if (!final) return;
  if (order > final.order) {
    throw Object.assign(
      new Error(
        `${label} sits above your final class ${final.name} — confirm to create it above the final year`,
      ),
      { code: 'ABOVE_FINAL_CONFIRM', finalLevel: final },
    );
  }
};

/**
 * Mark a level as the school's final class, clearing the previous one.
 *
 * Clear-then-set in ONE transaction, so the partial unique index is never
 * violated by the ordinary path while still being the guarantee. Clearing first
 * (rather than setting then clearing) is what makes re-marking the SAME level
 * idempotent — setting first would collide with the row being replaced.
 *
 * `levelId = null` clears the setting outright, which returns the school to the
 * derived fallback. That is a real action, not a degenerate one: a school that
 * marked the wrong level, or has not decided, needs a way back.
 *
 * @param {{levelId: string|null}} input
 * @returns the marked level, or null when cleared
 */
const setFinalLevel = async ({ levelId }) => prisma.$transaction(async (tx) => {
  if (levelId) {
    const level = await tx.gradeLevel.findUnique({ where: { id: levelId } });
    if (!level) throw Object.assign(new Error('Class level not found'), { code: 'NOT_FOUND' });
  }

  // Clear whatever was final. A no-op when nothing was, so the common first-time
  // call costs one cheap UPDATE.
  await tx.gradeLevel.updateMany({ where: { isFinal: true }, data: { isFinal: false } });

  if (!levelId) return null;
  return tx.gradeLevel.update({ where: { id: levelId }, data: { isFinal: true } });
}, { timeout: 30000, maxWait: 10000 });

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
 * `isFinal` is asked explicitly by the caller and defaults to FALSE — never
 * guessed. Adding a level is usually not the final class, but a small school's
 * next level genuinely may be, so the choice is put to the admin rather than
 * inferred from position: a school whose last year is currently Class 10 and who
 * adds Class 11 usually means 11 to be final, and a school inserting Playgroup
 * below certainly does not.
 *
 * `allowAboveFinal` is the deliberate opt-in for a level that sits ABOVE the
 * school's final class — planning Class 11 in April while Class 10 is still the
 * final year until the term ends. Defaults to FALSE, so the write is refused once
 * with ABOVE_FINAL_CONFIRM unless the caller confirms. See
 * `assertNotAboveFinal`.
 *
 * @param {{name: string, afterId?: string|null, isFinal?: boolean, allowAboveFinal?: boolean}} input
 * @returns the created level
 */
const createLevel = async ({ name, afterId = null, isFinal = false, allowAboveFinal = false }) => {
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

    /* Above the final class? Refused once unless the caller opted in — checked
       BEFORE any write, so a refusal leaves the level list exactly as it was. */
    await assertNotAboveFinal(tx, { order: newOrder, label: `Level ${trimmed}` }, allowAboveFinal);

    // Make room, then insert. Renumber from the bottom up so no two rows collide
    // on the unique order index mid-transaction.
    if (at !== -1) {
      const below = levels.slice(at + 1);
      for (const level of [...below].reverse()) {
        await tx.gradeLevel.update({ where: { id: level.id }, data: { order: level.order + 1 } });
      }
    }

    /* The new level is final, so the previous one must stop being final in the
       same transaction — the partial unique index would refuse two. Cleared
       before the insert, not after, so the index never has to be violated. */
    if (isFinal) {
      await tx.gradeLevel.updateMany({ where: { isFinal: true }, data: { isFinal: false } });
    }

    const level = await tx.gradeLevel.create({
      data: { id: `gl-${levelSlug(trimmed)}`, name: trimmed, order: newOrder, isFinal },
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
 * ## Above the final class
 *
 * A class whose LEVEL sits above the school's final class is refused once with
 * ABOVE_FINAL_CONFIRM unless `allowAboveFinal` is true — the same deliberate
 * opt-in the level route asks for, because a class above the final year is the
 * same decision one step down.
 *
 * The check is on the class's OWN level order, so it is asked AGAIN for a second
 * section of an already-above-final level rather than being remembered as
 * "already allowed". That is intentional: a standing exemption would let a later
 * admin fill an above-final level silently, with no record that anyone decided
 * to. Asking each time keeps the decision visible, and the UI shows the warning
 * with a checkbox so it is one click.
 *
 * @param {{levelId: string, section: string, allowAboveFinal?: boolean}} input
 * @returns {{cls: object, created: boolean}} `created` false when it already existed
 */
const createClass = async ({ levelId, section, allowAboveFinal = false }) => {
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

    /* An EXISTING class is returned above without the check: it was already
     * created, and re-asking on a duplicate would turn "this already exists" into
     * a misleading above-final refusal. Only a NEW class is judged. */
    await assertNotAboveFinal(
      tx,
      { order: level.order, label: classLabel({ grade: level.order, section: letter, level }) },
      allowAboveFinal,
    );

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
 *
 * Deleting the FINAL level is allowed (once it holds no classes) but reported:
 * the returned `clearedFinal` says whether this delete cleared the school's
 * final-class setting, so the caller can warn before doing it. It is never
 * silently dropped — the service tells the truth about what it removed, and the
 * route refuses the call outright unless the admin confirmed.
 */
const deleteLevel = async ({ levelId, confirmed = false } = {}) => prisma.$transaction(async (tx) => {
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

  /* The level being removed is the school's final class. The delete would leave
     the school with none, which is a legitimate state — but it is a real change
     to how the whole Promote tab reads, so it is a decision, not a side effect.
     Refused once with a distinguishable code; the caller re-asks and sends
     `confirmed`. Checked before any write, so the refusal leaves nothing behind. */
  if (level.isFinal && !confirmed) {
    throw Object.assign(
      new Error(`${level.name} is the final class — removing it will clear the final-class setting`),
      { code: 'FINAL_LEVEL_CONFIRM', level },
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
  return { ...level, clearedFinal: Boolean(level.isFinal) };
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
  finalLevel,
  isFinalOrder,
  hasFinalLevel,
  assertNotAboveFinal,
  setFinalLevel,
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
