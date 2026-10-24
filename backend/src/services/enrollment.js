/**
 * Academic years, class enrollments, and the identity match that lets one child be
 * recognised across years.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A student's class used to be a single column (`Student.classId`) that promotion
 * overwrote. The year they spent in the previous class then ceased to exist
 * anywhere: its register, its attendance totals and its mark sheets had all been
 * written against a class they no longer belonged to. Nothing could answer "who was
 * in 8-A last year", which is the question Class History exists to answer.
 *
 * `StudentEnrollment` is the fix — one row per (student, academic year). The
 * `Student.classId` column stays as the CURRENT class so the ~30 call sites that
 * ask "who is on this register today" remain one indexed column rather than a
 * join, but it is written from exactly ONE place: `moveStudents` / `passOutClass`
 * below, always inside the same transaction as the enrollment rows.
 *
 * ── The two rules worth stating ──────────────────────────────────────────────
 *
 * 1. AN ACADEMIC YEAR IS A DATE RANGE, not a label. Attendance and marks belong
 *    to the year their own date falls in, DERIVED on read by `yearForDate`. A
 *    record therefore cannot disagree with the calendar about which year it is in,
 *    because it never stores that answer. `isCurrent` is read for display and
 *    asserted against the range, never used as the authority for resolving "now".
 *
 * 2. IDENTITY IS NAME + GUARDIAN NAME + GUARDIAN CONTACT, NEVER A ROLL NUMBER.
 *    Roll numbers are reassigned every year — that is the entire point of a
 *    promotion — so they are worthless for telling one child from another across
 *    a year boundary. These three fields are the durable key, and `matchIdentity`
 *    is the single place that comparison happens, so the promotion review screen
 *    and the "Enter Past Data" search cannot grade a match differently.
 *
 * Nothing here is hardcoded: the top grade, the year list, the class structure of
 * any year and every student figure are read or derived from the real tables.
 */
const prisma = require('./prisma');
const { classIdOf, classLabel } = require('./mappers');
const fees = require('./fees');
const classesService = require('./classes');

/* ═══════════════════════════════════════════════════════════════════════════
   Identity
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Fold a name to a comparable form: lower case, punctuation and spacing removed.
 *
 * Registers are typed by hand, so "Rajesh  Kumar", "rajesh kumar" and "Rajesh
 * Kumar." are the same person, and "Rajesh  Kumar" must not read as a different
 * one. Diacritics are deliberately NOT stripped (Intl support varies by runtime
 * and a partial strip is worse than none) but the common punctuation that appears
 * in a guardian's name — apostrophes, hyphens, periods — is removed, because
 * "Anita's" vs "Anitas" is a real difference in the typing, not the person.
 */
const normText = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();

/**
 * A looser fold for the DATABASE-side search only: lower case, punctuation
 * dropped, whitespace collapsed to single spaces — but spaces KEPT.
 *
 * This exists because `normText` is not usable as a SQL `contains` filter. It
 * folds "Arjun Kumar" to "arjunkumar", and `contains 'arjunkumar'` does not match
 * the stored "Arjun Kumar" — a filter that silently finds nothing is worse than
 * no filter at all, so the two folds are kept separate and each is used where it
 * is actually valid.
 */
const normSearch = (v) => String(v ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Fold a phone number to its subscriber digits.
 *
 * The same guardian is written '+91-9876543210', '09876543210' and
 * '9876543210' across three different years of registers, and all three are the
 * same person. So: digits only, then the LAST TEN are compared — which drops a
 * country code (+91), a trunk zero (0) and any extension padding alike, without
 * the list of special cases having to be extended each time someone types a
 * number in yet another way.
 *
 * Anything that does not reduce to at least one digit is returned empty, which is
 * treated as "unknown" by the matcher rather than as a value that could match
 * another blank.
 */
const normContact = (v) => {
  const digits = String(v ?? '').replace(/\D+/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

/** The durable identity triple for a student row. */
const identityOf = (s) => ({
  name: normText(s?.name),
  guardianName: normText(s?.parentName),
  contact: normContact(s?.guardianContact),
});

/**
 * The same triple in the shape `matchIdentity` SEARCHES on — unfused values.
 *
 * These two look interchangeable and are not, which is the whole reason this
 * function exists. `identityOf` folds away spacing, so it yields "arjunkumar"; the
 * database holds "Arjun Kumar", and searching for the folded form finds nothing.
 * So the fused form is for COMPARING two records, and this raw form is for
 * FINDING candidates. Passing `identityOf` to `matchIdentity` silently returns an
 * empty result — which in the promotion review means every duplicate in the class
 * reads as clean.
 */
const observedOf = (s) => ({
  name: s?.name,
  parentName: s?.parentName,
  guardianContact: s?.guardianContact,
});

/**
 * How many candidate rows `findDuplicateStudent` will grade before giving up.
 *
 * A search can afford to stop early — the admin can retype a longer query. A
 * duplicate check cannot: a miss silently creates a second record for the same
 * child, which no later step can undo. So this is deliberately larger than the
 * search pool, and a school that outgrows it will still find every duplicate
 * whose name tokens appear in the first page of the name-ordered table.
 */
const DEDUPE_POOL_SIZE = 5000;

/** 'ramesh kumar' → 'Ramesh Kumar', for showing two similar names side by side. */
const titleCase = (v) => {
  const parts = String(v ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

/**
 * How well an observed identity triple matches a student record.
 *
 * Three tiers, chosen so the UI can act on each one differently:
 *
 *   exact     all three fields agree after normalisation. Safe to attach silently.
 *   partial   the name and ONE guardian field agree, the other differs. This is
 *             the "contact was reissued" case: almost certainly the same child,
 *             but a wrong auto-attach would graft one family's record onto
 *             another, so it is proposed and confirmed.
 *   weak      only the name agrees. Common-names territory: never auto-resolved.
 *   none      nothing agrees.
 *
 * The tier is computed, never asked for — a caller cannot declare a match good.
 *
 * ## `partial` — searching is not identifying
 *
 * The two callers want genuinely different things, and conflating them was a real
 * bug: the "Enter Past Data" search found nothing at all, because it was graded by
 * identifying rules and a name fragment ("arjun") is not a whole name ("arjunkumar").
 *
 *   partial: false (default) — IDENTIFYING. "Is this the same child?" The name must
 *     agree as a WHOLE name. "Arjun" is not "Arjun Kumar", and treating a fragment
 *     as identity would merge two genuinely different children who share a first
 *     name — in a school register, not a rare thing.
 *
 *   partial: true — SEARCHING. "Which students could this be?" The admin is
 *     choosing from a list, so a fragment matching a name is a useful result, and
 *     so is a contact on its own: the requirement is to find a child "by name,
 *     guardian name, or contact", and a contact-only query has no name to agree
 *     with at all.
 *
 * `observed` is taken as the RAW typed values and folded here, through exactly the
 * same `identityOf` the student rows go through. Folding only one side of the
 * comparison is the bug this shape exists to prevent: "Arjun Kumar" and
 * "arjunkumar" are the same child, and comparing a folded value against an unfolded
 * one reports them as strangers while the school stares at two identical records.
 */
const gradeMatch = (observed, student, { partial = false } = {}) => {
  const seen = identityOf(observed);
  const target = identityOf(student);

  /* In search mode a fragment counts: the admin typed part of a name and expects
     candidates. In identifying mode it has to be the whole name. */
  const nameAgrees = Boolean(seen.name) && (partial
    ? (target.name.includes(seen.name) || seen.name.includes(target.name))
    : seen.name === target.name);
  const guardianAgrees = Boolean(seen.guardianName) && seen.guardianName === target.guardianName;
  const contactAgrees = Boolean(seen.contact) && seen.contact === target.contact;

  const agrees = { name: nameAgrees, guardianName: guardianAgrees, contact: contactAgrees };
  const agreed = Object.values(agrees).filter(Boolean).length;
  // A field the register did not supply cannot count as agreement — otherwise a
  // blank guardian name would "match" every student with a blank guardian name.
  const supplied = Object.values(seen).filter(Boolean).length;

  if (supplied === 0 || agreed === 0) return { tier: 'none', agrees, agreed };

  if (partial) {
    if (agreed === 3) return { tier: 'exact', agrees, agreed };
    if (agreed === 2) return { tier: 'partial', agrees, agreed };
    return { tier: 'weak', agrees, agreed };
  }

  // Identifying: the name is the anchor, so a candidate without one is not a match.
  if (!nameAgrees) return { tier: 'none', agrees, agreed };
  // All three agree. Reached either by supplying all three and having all three
  // agree, or by supplying fewer and having every supplied field agree AND the
  // guardian pair agree — in which case the third field is unknowable either way,
  // so it is reported rather than assumed.
  if (agreed === 3 || (agreed === supplied && guardianAgrees && contactAgrees)) {
    return { tier: 'exact', agrees, agreed };
  }
  if (nameAgrees && (guardianAgrees || contactAgrees)) return { tier: 'partial', agrees, agreed };
  return { tier: 'weak', agrees, agreed };
};

/** Rank for sorting: a better match is always shown first. */
const TIER_RANK = { exact: 0, partial: 1, weak: 2, none: 3 };

/**
 * Id for an Exam row this app creates itself, in the seeded 'exam-…' style.
 *
 * `Date.now()` alone is NOT enough here, and the difference from
 * services/marks.js is deliberate: a bulk backfill creates one exam per distinct
 * exam name in a single loop, so several ids are minted inside the same
 * millisecond and `exam-<same number>` would collide on the primary key, failing
 * the whole batch. A monotonic per-process counter makes them unique within a
 * process, and the timestamp keeps them unique across processes.
 */
let examSeq = 0;
const newExamId = () => `exam-${Date.now().toString(36)}-${(examSeq += 1).toString(36)}`;

/**
 * Id for a student created by "Enter Past Data", in the same 'stu-<stamp>-<seq>'
 * shape the ordinary admission route uses, so the two kinds of record are not
 * distinguishable by looking at an id.
 *
 * The counter is what makes it unique: backfilling a whole year of a large class
 * creates students in quick succession, and a bare timestamp collides on the
 * primary key exactly as `newExamId` would.
 */
let studentSeq = 0;
const newStudentId = () => `stu-${Date.now().toString(36)}${(studentSeq += 1).toString(36)}`;

/**
 * Find every student an observed identity triple could plausibly be, best first.
 *
 * Used by two callers that must agree with each other: the promotion review screen
 * (is this student a duplicate of another record?) and the "Enter Past Data"
 * search (which existing child does this register line belong to?). Sharing one
 * implementation is what stops them from disagreeing about whether a match is
 * safe.
 *
 * @param {{name?:string, parentName?:string, guardianContact?:string}} observed
 * @param {{excludeStudentIds?: string[], limit?: number, client?: object, partial?: boolean}} [opts]
 * @returns {Promise<Array<{student: object, tier: string, agrees: object}>>}
 */
const matchIdentity = async (observed, opts = {}) => {
  const { excludeStudentIds = [], limit = 50 } = opts;
  const poolTake = opts.take || 500;
  /* `client` lets a caller pass a transaction handle, so a duplicate check made
     INSIDE a promotion transaction reads the same snapshot the write will act on.
     Without it the check would read committed state through the pool while the
     surrounding transaction holds a different view — two different answers to "is
     this a duplicate" depending on which connection was picked. */
  const db = opts.client || prisma;
  const nameTokens = normSearch(observed?.name).split(' ').filter((t) => t.length >= 2);
  /* Candidate narrowing happens in the database; grading happens in JS.

     The name is matched token-by-token with `contains` (case-insensitive) rather
     than as one folded string, because a token IS a plain substring of the stored
     name however it was typed: 'arjun' matches "Arjun Kumar", "ArjunK. Kumar"
     and "ARJUN  KUMAR" alike. That matters because the alternative — a single
     folded needle — misses any row whose spacing differs from the typing, and a
     MISS here is the one failure this function cannot recover from: it would
     report a child as unknown and offer to create a duplicate of them.

     `guardianName` and `contact` are deliberately NOT part of the database filter
     for the same reason one level up: they are only comparable after folding, and
     a `where` clause compares raw strings, so '+91-9876543210' would not match
     '9876543210'. They are graded in JS, by the same `normContact` used above.

     Over-fetching is safe (JS grading drops non-matches); under-fetching is not,
     so the filter is deliberately generous and capped. */
  const pool = await db.student.findMany({
    where: {
      // Every token the register gave us must appear somewhere in the name. No
      // name at all means no name filter — the guardian fields still narrow it,
      // and a blank-name search over a school-sized table is bounded by `take`.
      ...(nameTokens.length
        ? { AND: nameTokens.map((t) => ({ name: { contains: t, mode: 'insensitive' } })) }
        : {}),
      id: { notIn: excludeStudentIds },
    },
    take: poolTake,
    // The class is loaded so a caller can say WHERE the existing student is. It
    // costs one join on an already-narrowed row set, and a duplicate message that
    // says "already exists" without a class sends the office hunting. The level
    // rides along so a named class reads 'Nursery A' rather than falling back to
    // its order.
    include: { class: { select: { grade: true, section: true, level: { select: { name: true, order: true } } } } },
    orderBy: { name: 'asc' },
  });

  const matches = pool
    .map((student) => {
      const { tier, agrees } = gradeMatch(observed, student, { partial: Boolean(opts.partial) });
      return { student, tier, agrees };
    })
    .filter((m) => m.tier !== 'none')
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]
      || b.agreed - a.agreed
      || String(a.student.name).localeCompare(String(b.student.name)));

  return matches.slice(0, limit);
};

/**
 * The ONE duplicate rule: a student is a DUPLICATE when name, guardian name and
 * guardian contact all agree after normalisation — the same PERSON, not the same
 * seat. Roll number and class deliberately take no part: a roll number is
 * reassigned every year, and the same child sitting in two different classes is
 * the exact mistake this has to catch.
 *
 * This is a read of `matchIdentity`, not a second implementation of it. There is
 * one normalisation (`identityOf`), one grader (`gradeMatch`) and therefore one
 * answer to "is this the same child" everywhere in the app.
 *
 * Siblings are NOT duplicates: the guardian and contact may match while the name
 * differs, and only an `exact` tier — all three fields — counts here.
 *
 * @param {{name?:string, parentName?:string, guardianContact?:string}} observed
 * @param {{excludeStudentIds?: string[], client?: object}} [opts]
 *        `excludeStudentIds` is how "Edit Student" leaves out the row being edited.
 *        `client` is how a caller runs the check inside its own transaction.
 * @returns {Promise<Array>} the existing students this would duplicate (may be
 *          more than one — an existing pair will both come back)
 */
const findDuplicateStudent = async (observed, opts = {}) => {
  const matches = await matchIdentity(observed, {
    ...opts,
    // IDENTIFYING, not searching: a name fragment is not a whole child.
    partial: false,
    // Widened on purpose. A duplicate is the single most expensive miss in the
    // app — it silently creates a second record for the same child — so the
    // generous cap used for a search is lifted for this one question.
    take: DEDUPE_POOL_SIZE,
    limit: 10,
  });
  return matches.filter((m) => m.tier === 'exact');
};

/**
 * The sentence shown when a duplicate is refused. It names the student who is
 * already on file and enough of their identity to find them, because "a duplicate
 * exists" sends the office hunting while "Rahul Menon (guardian Anand Menon,
 * 9845678901) already exists in Class 9B" sends them straight to the row.
 *
 * @param {object} match a `findDuplicateStudent` hit
 * @returns {string}
 */
const duplicateMessage = (match) => {
  const s = match?.student || {};
  const name = titleCase(s.name);
  const where = s.class
    ? `already exists in ${classLabel(s.class)}`
    : 'already exists (no current class)';
  // The parenthetical carries only what is actually on file, so a record with
  // no guardian name reads "Rahul Menon (9845678901)" rather than "(guardian )".
  const inner = [];
  if (s.parentName) inner.push(`guardian ${titleCase(s.parentName)}`);
  if (s.guardianContact) inner.push(normContact(s.guardianContact));
  return `${name}${inner.length ? ` (${inner.join(', ')})` : ''} ${where}.`;
};

/**
 * A lock key for one identity triple, so two simultaneous admissions of the same
 * child cannot both pass the duplicate check.
 *
 * The check-then-write sequence is inherently racy: two requests can each read
 * "no such student" from their own transaction snapshot and both insert. A
 * Postgres transaction-scoped advisory lock on the identity hash serialises them —
 * the second waits, then reads the first's row and is refused. It costs one
 * `SELECT` per write and is released automatically on commit or rollback.
 *
 * @param {{name?:string, parentName?:string, guardianContact?:string}} observed
 * @returns {string} a stable key derived from the normalised triple
 */
const identityLockKey = (observed) => {
  const { name, guardianName, contact } = identityOf(observed);
  return `student-identity:${name}:${guardianName}:${contact}`;
};

/**
 * Take the advisory lock for an identity triple. Call INSIDE a transaction.
 * `hashtext` is undocumented but stable across every supported Postgres; if it
 * ever disappears, any hash works — the requirement is only that the same
 * identity maps to the same number.
 */
const lockIdentity = async (db, observed) => db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${identityLockKey(observed)}))`;

/* ═══════════════════════════════════════════════════════════════════════════
   Academic years
   ═══════════════════════════════════════════════════════════════════════════ */

/** Today in the school timezone, as a Date at UTC midnight (see mappers.schoolToday). */
const today = () => {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new Date(`${iso}T00:00:00.000Z`);
};

/**
 * Every academic year, newest first, with `isCurrent` recomputed from its range.
 *
 * The stored flag is overridden rather than trusted. A flag that had quietly
 * drifted from the calendar would make two parts of the app disagree about which
 * year the school is in, and the disagreement would surface as a promotion landing
 * in the wrong year — a far worse failure than a redundant read.
 */
const listYears = async () => {
  const now = today();
  const rows = await prisma.academicYear.findMany({ orderBy: { startDate: 'desc' } });
  return rows.map((y) => ({
    ...y,
    startDate: y.startDate.toISOString().slice(0, 10),
    endDate: y.endDate.toISOString().slice(0, 10),
    isCurrent: now >= y.startDate && now <= y.endDate,
  }));
};

/**
 * The academic year containing today, by RANGE.
 *
 * `client` lets this be resolved inside a transaction, so a write and the year it
 * is tagged with are decided against the same snapshot rather than against
 * whatever the pool happened to hand back.
 *
 * @returns {Promise<object|null>} null only if the school has no year configured
 */
const currentYear = async (client = prisma) => {
  const now = today();
  const rows = await client.academicYear.findMany({ orderBy: { startDate: 'desc' } });
  return rows.find((y) => now >= y.startDate && now <= y.endDate) || null;
};

/**
 * The academic year containing a date, by RANGE.
 *
 * This is what makes "attendance and marks are tagged with an academic year"
 * true without a stored column that could go stale: the year is a pure function of
 * the date and the calendar. An unparseable or out-of-calendar date returns null,
 * and callers treat that as "belongs to no year" rather than guessing.
 */
const yearForDate = (date, years) => {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return years.find((y) => d >= y.startDate && d <= y.endDate) || null;
};

/**
 * The year immediately after `yearId`, in startDate order.
 *
 * "Next year" is resolved from the table rather than computed as "current + 1",
 * because a school that has skipped a year (or a database seeded with a gap)
 * should promote into the year that actually follows, which may be two labels
 * away.
 *
 * @param {string} yearId
 * @param {object} [client] a Prisma client or transaction handle. Promotion
 *        resolves this INSIDE its transaction, so it must read through the same
 *        handle its writes will use — reading the global client there would be a
 *        different snapshot. Defaults to the global client for every other caller.
 */
const nextYearAfter = async (yearId, client = prisma) => {
  const years = await client.academicYear.findMany({ orderBy: { startDate: 'asc' } });
  const i = years.findIndex((y) => y.id === yearId);
  return i >= 0 ? (years[i + 1] || null) : null;
};

/* ═══════════════════════════════════════════════════════════════════════════
   Class structure
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every class, with the number of students currently in it, newest grade last.
 *
 * The count comes from `Student.classId` (the current-class pointer) rather than
 * from the enrollment table, because that is the same number every other roster,
 * headcount and `_count.students` query in the app reports. Deriving it two ways
 * would let the Promote tab disagree with the Students page about how full a class
 * is — which is precisely the kind of quiet inconsistency that makes an admin stop
 * trusting the screen they are about to act on.
 */
/**
 * The level that follows a given order, or null when that order is the last one.
 *
 * ONE definition of "the next level", read from the table. The alternative —
 * computing order + 1 and looking that up — breaks the moment a level is inserted
 * between two others, because every order below it shifts by one and the +1
 * arithmetic then points somewhere that is not adjacent any more.
 *
 * Not cached: a promotion resolves the chain once per request, which is one extra
 * query on a 13-row table. Caching it would mean invalidating it on every level
 * edit for a saving that does not show.
 *
 * @param {number|null} order the order to follow
 * @param {object} [client] a transaction handle, so a promotion inside one reads
 *        the same snapshot its writes will act on
 */
const nextLevelByOrder = async (order, client = null) => {
  if (order === null || order === undefined) return null;
  const db = client || prisma;
  return db.gradeLevel.findFirst({
    where: { order: { gt: order } },
    orderBy: { order: 'asc' },
  });
};

const classOverview = async () => {
  const year = await currentYear();
  if (!year) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });
  const next = await nextYearAfter(year.id);

  const classes = await prisma.class.findMany({
    orderBy: [{ grade: 'asc' }, { section: 'asc' }],
    include: { _count: { select: { students: true, enrollments: true } }, level: true },
  });

  /* The top grade — the class that graduates rather than promotes.

     Derived from the classes that actually have students THIS year, not from the
     highest grade in the table. Those two differ whenever a school has an empty
     row left behind (a class created for a year that never filled, or a section
     that closed), and an empty 11-A would otherwise make the real 10-A offer to
     promote into a class that does not exist. The fallback to the whole table is
     for a school mid-onboarding, where no class has students yet and a top grade
     still has to be named.

     Compared on the LEVEL ORDER, which is what `Class.grade` holds — so a
     pre-primary level (a negative order) can never outrank Class 10 and steal the
     graduating title.

     The basis is returned so the UI can show WHICH rule decided it: "highest grade
     with students: 10" is an assumption the office can check, whereas a top class
     that appears without explanation is just a surprise. */
  const orderOf = (c) => (c.level ? c.level.order : c.grade);
  const withStudents = classes.filter((c) => c._count.students > 0);
  const pool = withStudents.length ? withStudents : classes;
  const basis = withStudents.length ? 'classes_with_students' : 'all_classes';
  const topGrade = pool.reduce((max, c) => Math.max(max, orderOf(c)), 0);

  const exists = new Set(classes.map((c) => c.id));

  /* How much of this year's register is still to be moved. Counted from the
     YEAR'S ENROLLMENT ROWS — the same set the roster modal lists — not from
     `_count.students`: a child moved individually keeps a seat in this year's
     register, so counting by the live pointer would drop them and understate how
     much of the class has already been handled. */
  const registerByClass = new Map();
  const handledByClass = new Map();
  const registerRows = await prisma.studentEnrollment.findMany({
    where: { academicYearId: year.id },
    select: { classId: true, studentId: true },
  });
  const handledIds = new Set(
    (await prisma.studentEnrollment.findMany({
      where: { status: 'active', academicYear: { startDate: { gt: year.startDate } } },
      select: { studentId: true },
    })).map((r) => r.studentId),
  );
  for (const row of registerRows) {
    registerByClass.set(row.classId, (registerByClass.get(row.classId) || 0) + 1);
    if (handledIds.has(row.studentId)) {
      handledByClass.set(row.classId, (handledByClass.get(row.classId) || 0) + 1);
    }
  }

  /* The chain, resolved once per class. Read inside the same read path rather than
     cached: one query per class on a 13-row table, which is cheaper than an
     invalidation. */
  const chains = new Map();
  for (const c of classes) {
    chains.set(c.id, await nextLevelByOrder(orderOf(c)));
  }

  /* The graduating level, named. The banner must show a LEVEL NAME, never an order
     number — an office does not know what "10" means if their levels are Nursery,
     LKG, UKG and 1..10, and it knows exactly what "Class 10" means. */
  const topLevelRow = await prisma.gradeLevel.findUnique({ where: { order: topGrade } });

  return {
    currentAcademicYear: year,
    nextAcademicYear: next,
    topGrade,
    // Kept for the existing callers that read the order; the screen uses the label.
    topLevelLabel: topLevelRow ? topLevelRow.name : String(topGrade),
    topGradeBasis: basis,
    classes: classes.map((c) => {
      const isTop = orderOf(c) === topGrade;
      // The next class is the next LEVEL in the order, with the same section —
      // never grade + 1, which a level inserted above would make wrong.
      const nextLevel = chains.get(c.id) || null;
      const targetId = nextLevel ? classIdOf(nextLevel.name, c.section) : null;
      return {
        id: c.id,
        grade: c.grade,
        section: c.section,
        label: classLabel(c),
        levelId: c.levelId,
        levelName: c.level ? c.level.name : null,
        order: orderOf(c),
        studentCount: c._count.students,
        enrollmentCount: c._count.enrollments,
        registerCount: registerByClass.get(c.id) || 0,
        handledCount: handledByClass.get(c.id) || 0,
        remainingCount: (registerByClass.get(c.id) || 0) - (handledByClass.get(c.id) || 0),
        isTop,
        // 'passed_out' on the top grade, 'promote' below it, 'none' when there is
        // nothing to move — an empty class cannot be promoted or graduated, and
        // offering either would promise a result the transaction could not deliver.
        action: c._count.students === 0 ? 'none' : isTop ? 'passed_out' : (nextLevel ? 'promote' : 'passed_out'),
        // A class on the TOP level has nowhere to promote to — it graduates. A
        // class whose level has no successor offers pass-out only, with the
        // reason: the admin can add a level, but the app will not invent one.
        targetClassId: isTop ? null : targetId,
        targetClassLabel: isTop || !nextLevel
          ? null
          : classLabel({ order: nextLevel.order, section: c.section, level: nextLevel }),
        // The target class is created on demand, exactly as admitting a student to a
        // new section creates that section. Reported so the confirmation can say
        // "Class 10B will be created" instead of silently growing the school.
        targetWillBeCreated: !isTop && Boolean(targetId) && !exists.has(targetId),
        // Why there is no target: the top level graduates, or the level has no
        // successor in the list. The screen uses this to explain what to do.
        noNextLevelReason: isTop ? 'top' : (nextLevel ? null : 'no_next_level'),
        promotedFromLabel: null,
      };
    }),
  };
};

/**
 * The classes that existed in a given academic year.
 *
 * Two different questions share this function, and which one a caller wants
 * decides what it filters:
 *
 *   Class History wants the structure AS IT WAS — classes that actually had
 *   students that year. Today's empty 9-B (which now holds nobody because they
 *   were promoted into 10-B) must not appear in a 2024-25 selector, or the admin
 *   picks a class and is shown an empty list for a year it never ran.
 *
 *   Enter Past Data also wants today's classes, so a year can be started for a
 *   section before anybody is entered into it.
 *
 * So both are returned, counted, and unfiltered — `used` and `historyCount`.
 */
const classesForYear = async (academicYearId) => {
  const [classes, counts] = await Promise.all([
    prisma.class.findMany({
      orderBy: [{ grade: 'asc' }, { section: 'asc' }],
      include: { level: true },
    }),
    prisma.studentEnrollment.groupBy({
      by: ['classId'],
      where: { academicYearId },
      _count: { _all: true },
    }),
  ]);
  const countByClass = new Map(counts.map((c) => [c.classId, c._count._all]));
  return classes.map((c) => {
    const historyCount = countByClass.get(c.id) || 0;
    return {
      id: c.id,
      grade: c.grade,
      section: c.section,
      order: c.level ? c.level.order : c.grade,
      levelId: c.levelId,
      levelName: c.level ? c.level.name : null,
      label: classLabel(c),
      historyCount,
      // True when this class actually ran that year — the filter Class History uses.
      existed: historyCount > 0,
    };
  });
};

/**
 * Everyone in one class in one academic year.
 *
 * Reads the enrollment table, NEVER `Student.classId` — that column is by
 * definition the class a student is in NOW, so using it here would return today's
 * class for a year being asked about, which is the exact bug this feature exists
 * to eliminate. Rows are returned whatever their status, because a promoted or
 * graduated student's row is the record of that year.
 */
const rosterFor = async ({ academicYearId, classId }) => {
  const rows = await prisma.studentEnrollment.findMany({
    where: { academicYearId, classId },
    orderBy: [{ student: { name: 'asc' } }],
    include: {
      student: { include: { class: { include: { level: true } } } },
      class: { include: { level: true } },
    },
  });

  /* `promotedFromClassId` is a bare id, and a Class History row is read as a
     sentence ("promoted from Class 9B"), so it has to be resolved to a label. All
     the referenced classes are fetched in ONE query rather than per row: a year of
     9A and 9B has two distinct sources, so an N+1 here would be pure waste. */
  const fromIds = [...new Set(rows.map((r) => r.promotedFromClassId).filter(Boolean))];
  const fromClasses = fromIds.length
    ? await prisma.class.findMany({ where: { id: { in: fromIds } }, include: { level: true } })
    : [];
  const fromLabelById = new Map(fromClasses.map((c) => [c.id, classLabel(c)]));

  return rows.map((e) => ({
    enrollmentId: e.id,
    studentId: e.studentId,
    name: e.student.name,
    photo: e.student.photo,
    // The roll number they held THAT year, which is not the student's current one.
    rollNumber: e.rollNumber,
    status: e.status,
    source: e.source,
    matchConfidence: e.matchConfidence,
    promotedFromClassId: e.promotedFromClassId,
    promotedFromLabel: e.promotedFromClassId ? (fromLabelById.get(e.promotedFromClassId) || e.promotedFromClassId) : null,
    currentClassLabel: e.student.class ? classLabel(e.student.class) : null,
    isCurrentlyHere: Boolean(e.student.classId) && e.student.classId === e.classId,
  }));
};

/* ═══════════════════════════════════════════════════════════════════════════
   Keeping the live enrollment in step
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Make a student's live enrollment agree with the class they actually hold.
 *
 * `Student.classId` is the pointer the whole app reads, and `StudentEnrollment` is
 * the history it must be reconstructable from. Two writers update the pointer
 * without going through a promotion — admitting a student, and correcting a class
 * on an existing record — and this is the function both call, so the two can never
 * drift apart.
 *
 * ## Which row is "live"
 *
 * The student's most recent ACTIVE enrollment, NOT their current-year one. Those
 * differ during a promotion: promoting 9-B writes the child's seat into NEXT
 * year's register and closes this year's row, so from that moment the child's live
 * row belongs to the year that has not started. Keyed on the current year instead,
 * an unrelated profile edit would find no active row for it and "helpfully" reopen
 * the closed one — silently rewriting the year they graduated 9-B.
 *
 * A child holding no class (a graduate) has no live row to update, and is left
 * alone: being an alumnus is not an error to repair.
 *
 * @param {object} client a Prisma client or transaction handle
 * @param {string} studentId
 * @returns {Promise<object|null>} the live row, or null when there is nothing to do
 */
const syncLiveEnrollment = async (client, studentId) => {
  const student = await client.student.findUnique({ where: { id: studentId } });
  if (!student || !student.classId) return null;

  const live = await client.studentEnrollment.findFirst({
    where: { studentId, status: 'active' },
    orderBy: { academicYear: { startDate: 'desc' } },
  });

  if (live) {
    // The overwhelmingly common case — an edit that changed only the phone number.
    // Returning without writing is what keeps "edit a student's address" from
    // being an operation that also touches their enrollment history.
    if (live.classId === student.classId && live.rollNumber === student.rollNumber) return live;
    return client.studentEnrollment.update({
      where: { id: live.id },
      data: {
        classId: student.classId,
        // A correction can carry a new roll number for the same year, so both are
        // taken from the student row rather than leaving one stale.
        rollNumber: student.rollNumber,
        status: 'active',
        endedOn: null,
      },
    });
  }

  /* No live row: either a fresh admission, or a graduate being put back into a
     class. Both want a seat in the year the school is actually in. */
  const year = await currentYear(client);
  if (!year) {
    throw Object.assign(
      new Error('No academic year contains today, so this student cannot be placed on a register'),
      { code: 'NO_CURRENT_YEAR' },
    );
  }
  return client.studentEnrollment.create({
    data: {
      studentId,
      academicYearId: year.id,
      classId: student.classId,
      rollNumber: student.rollNumber,
      status: 'active',
      // 'live' — this seat came from the school recording the child in a class now,
      // as opposed to promotion's 'promoted' or a backfill's 'historical'.
      source: 'live',
      enrolledOn: today(),
    },
  });
};

/* ═══════════════════════════════════════════════════════════════════════════
   Promotion
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The students who currently HOLD a class, with the seat they hold it in.
 *
 * Selection follows `Student.classId` — the same pointer the Promote tab's
 * headcount, the Students page and every `_count.students` in the app is computed
 * from. Selecting by enrollment instead ("every row for this class in the current
 * year") looks equivalent and is not, because an enrollment row deliberately
 * OUTLIVES the seat: closing it as `promoted` is what preserves that year's
 * register.
 *
 * That difference was a live bug. Passing out an emptied class a second time found
 * the batch it had already promoted and re-labelled their `promoted` rows as
 * `passed_out` — quietly rewriting the year those children finished 9-B, and
 * making a second pass-out report students it had not just touched. Following the
 * pointer makes both actions safe to repeat, in the only sense that matters: a
 * child who has left the class is no longer in it, whoever still holds the record.
 *
 * @param {string} classId
 * @param {object} [client] a Prisma client or transaction handle
 * @returns {Promise<Array<{student: object, seat: object|null}>>}
 */
const liveStudentsOf = async (classId, client = prisma) => {
  const students = await client.student.findMany({
    where: { classId },
    include: {
      enrollments: {
        where: { status: 'active' },
        include: { academicYear: true, class: true },
        orderBy: { academicYear: { startDate: 'desc' } },
      },
    },
    orderBy: { name: 'asc' },
  });
  return students.map((student) => ({ student, seat: student.enrollments[0] || null }));
};

/** The batch's own students, minus those the admin excluded. */
const withoutExcluded = (batch, excludeSet) => batch.filter((b) => !excludeSet.has(b.student.id));

/**
 * What a promotion would do, and what needs a human to look at it.
 *
 * This is the review screen. It never changes anything — `promoteClass` re-derives
 * the same plan inside the transaction and refuses to act on a student the admin
 * has not dealt with, so a screen that was left open (or opened against a class
 * that changed underneath it) cannot promote a duplicate.
 *
 * ## What is being "matched", and why that is not circular
 *
 * A promotion moves students who are ALREADY student rows, so there is no foreign
 * roster to reconcile — which makes it look like there is nothing to match. The
 * check that earns its place is a different one: are these records DISTINCT?
 *
 * Two student rows for the same child are one of the most common data faults in
 * any school, and they are invisible on a class roster — the child appears once,
 * the duplicate sits in another class, and promotion then carries both forward,
 * producing two children who share a name, a guardian and a phone number in the
 * year above. So each student is graded against every OTHER record, and anything
 * that is not plainly distinct is flagged for a human.
 */
/**
 * Everything a promotion popup needs to render, for ONE student or ONE class.
 *
 * Returns the CURRENT year/class, the SUGGESTED next year/class, the list of
 * years an admin may choose, and the list of real classes. Nothing is typed in:
 * the current year is resolved by date range, the suggested year is the next row
 * in `AcademicYear`, the suggested class is the next level in the chain, the
 * allowed years are the rows AFTER the current one, and the classes are the rows
 * in `Class`.
 *
 * Passing a `studentId` scopes it to that child (their current class drives the
 * suggestion). Passing a `classId` scopes it to a class. Exactly one is required.
 *
 * @param {{studentId?: string, classId?: string}} args
 */
const promotionOptions = async ({ studentId = null, classId = null } = {}) => {
  if (!studentId && !classId) {
    throw Object.assign(new Error('Provide a student or a class'), { code: 'MISSING_IDENTITY' });
  }

  let source; // the class being moved out of
  let subject = null; // the student, when scoped to one

  if (studentId) {
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) throw Object.assign(new Error('Student not found'), { code: 'NOT_FOUND' });
    if (!student.classId) {
      throw Object.assign(new Error('This student is not in a current class'), { code: 'NO_CURRENT_CLASS' });
    }
    subject = {
      id: student.id,
      name: student.name,
      rollNumber: student.rollNumber,
    };
    source = await prisma.class.findUnique({ where: { id: student.classId }, include: { level: true } });
  } else {
    source = await prisma.class.findUnique({ where: { id: classId }, include: { level: true } });
  }
  if (!source) throw Object.assign(new Error('Class not found'), { code: 'NOT_FOUND' });

  const from = await currentYear();
  if (!from) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });

  /* The years an admin may move INTO: every year that starts after the current
     one, oldest first (the soonest ahead of them is the default). Read from the
     table, so a school with a gap in its years still gets the right list. */
  const allYears = await prisma.academicYear.findMany({ orderBy: { startDate: 'asc' } });
  const allowedYears = allYears
    .filter((y) => y.startDate > from.startDate)
    .map((y) => ({ id: y.id, label: y.label, startDate: y.startDate.toISOString().slice(0, 10), endDate: y.endDate.toISOString().slice(0, 10) }));

  /* The suggested next year is the first allowed one — the same row
     `nextYearAfter` would pick, so the popup's default and the automatic move
     agree. */
  const suggestedYear = allowedYears[0] || null;

  // The suggested next class, in the LEVEL CHAIN (preview only: `create: false`
  // resolves the id without writing it).
  const nextTarget = await classesService.nextClassFor(source.id, { create: false });

  // Every real class, for the dropdown. Read from the table, never a list.
  const classes = await prisma.class.findMany({
    orderBy: [{ grade: 'asc' }, { section: 'asc' }],
    include: { level: true },
  });
  const realClasses = classes.map((c) => ({
    id: c.id,
    grade: c.grade,
    section: c.section,
    order: c.level ? c.level.order : c.grade,
    levelId: c.levelId,
    levelName: c.level ? c.level.name : null,
    label: classLabel(c),
  }));

  return {
    student: subject,
    currentYear: { id: from.id, label: from.label },
    currentClass: realClasses.find((c) => c.id === source.id) || null,
    suggestedYear,
    suggestedClass: nextTarget
      ? { id: nextTarget.classId, label: nextTarget.label, willBeCreated: nextTarget.willBeCreated }
      : null,
    allowedYears,
    classes: realClasses,
  };
};

/**
 * The promotion review screen's plan, for the whole class.
 *
 * Everything a caller derives here is a PREVIEW of what `promoteClass` will do
 * when it re-derives the same batch inside its transaction.
 */
const promotionPlan = async ({ classId }) => {
  const overview = await classOverview();
  const source = overview.classes.find((c) => c.id === classId);
  if (!source) throw Object.assign(new Error('Class not found'), { code: 'NOT_FOUND' });
  const batch = await liveStudentsOf(classId);

  /* The review covers the children who will actually move this cycle. Anyone
     already seated in a later year was handled in an earlier pass (promoted, or
     kept back); they are counted, not re-reviewed. */
  const from = await currentYear();
  if (!from) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });
  const to = await nextYearAfter(from.id);
  if (!to) throw Object.assign(new Error('There is no academic year after the current one to promote into'), { code: 'NO_TARGET_YEAR' });
  const actionable = batch.filter(({ seat }) => !seat || seat.academicYearId === from.id);
  const alreadyHandledCount = batch.length - actionable.length;

  /* Grade every student against every other student in one pass.
     `matchIdentity` with the search over the WHOLE table (not just this class)
     because a duplicate is most often filed in a different class — which is
     precisely how it escapes a roster. */
  const grades = await Promise.all(actionable.map(async ({ student }) => {
    const rivals = await matchIdentity(observedOf(student), { excludeStudentIds: [student.id] });
    const exactRivals = rivals.filter((r) => r.tier === 'exact');
    const nearRivals = rivals.filter((r) => r.tier !== 'weak');
    const seen = identityOf(student);

    /* Two flags, because they call for different amounts of suspicion.
       - `duplicate`   another record carries this child's identity. Acting on it
                       would create or preserve a phantom classmate.
       - `unverifiable`this record cannot be checked at all, because a guardian
                       field is blank — the usual state of a hurried admission, and
                       it is not evidence of anything, which is precisely why it
                       must not be resolved silently in EITHER direction. */
    const missingFields = [];
    if (!seen.guardianName) missingFields.push('parentName');
    if (!seen.contact) missingFields.push('guardianContact');
    const duplicate = exactRivals.length > 0;
    const unverifiable = missingFields.length > 0;

    return {
      studentId: student.id,
      name: student.name,
      rollNumber: student.rollNumber,
      currentClassId: classId,
      identity: {
        name: student.name,
        parentName: student.parentName,
        guardianContact: student.guardianContact,
      },
      flags: {
        duplicate,
        unverifiable,
        missingFields,
        // Only rivals strong enough to be worth naming: a 'weak' match is just a
        // shared surname, and listing those would bury the real finding.
        rivals: nearRivals.map((r) => ({
          studentId: r.student.id,
          name: r.student.name,
          classId: r.student.classId,
          tier: r.tier,
          agrees: r.agrees,
        })),
      },
      needsReview: duplicate || unverifiable,
    };
  }));

  return {
    kind: 'promote',
    sourceClass: source,
    targetClass: source.targetClassId
      ? {
        id: source.targetClassId,
        label: source.targetClassLabel,
        willBeCreated: source.targetWillBeCreated,
      }
      : null,
    /* Why there is no target, so the review screen can say it instead of showing
       a button that cannot do anything. 'top' graduates; 'no_next_level' means
       the level simply has no successor and the admin can add one. */
    noNextLevelReason: source.noNextLevelReason,
    fromAcademicYear: from,
    toAcademicYear: to,
    students: grades,
    totalStudents: grades.length,
    alreadyHandledCount,
    needsReviewCount: grades.filter((g) => g.needsReview).length,
  };
};

/* ═══════════════════════════════════════════════════════════════════════════
   Chosen target (year + class) — ONE rule for every move
   ═══════════════════════════════════════════════════════════════════════════

   An admin may now pick WHERE a move goes instead of taking the automatic
   default. All three actions (promote, keep, pass-out-with-a-target) and both
   entry points (one student, a whole class) resolve the target through the
   function below, so the rules cannot drift apart between them.

   The rules, in one place:
     - YEAR: absent → the year after the student's current one (today's default).
             present → it must be a REAL year and LATER than the current one.
             The current year and any past year are refused, with the reason.
     - CLASS: absent → the automatic target (next level for `promote`, the same
             class for `keep`). present → it must be a REAL class.
     - SEAT: a student may hold only ONE seat per year. A move that would collide
             with an existing seat in the target year is refused, naming it.

   Nothing here is typed in: the default year is the next row in `AcademicYear`,
   the default class is the next level in `GradeLevel`, and a chosen class is
   whatever row exists in `Class`. */

/**
 * Resolve and validate the target year for a move.
 *
 * @param {object} db a Prisma client or transaction handle
 * @param {object} args
 * @param {object} args.from the year the student is in now (an AcademicYear row)
 * @param {string} [args.toAcademicYearId] the admin's chosen year id, if any
 * @returns {Promise<object>} the target AcademicYear row
 */
const resolveTargetYear = async (db, { from, toAcademicYearId }) => {
  if (!from) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });

  // No choice: the year that actually follows the current one (today's default).
  if (!toAcademicYearId) {
    const auto = await nextYearAfter(from.id, db);
    if (!auto) {
      throw Object.assign(
        new Error('There is no academic year after the current one to promote into'),
        { code: 'NO_TARGET_YEAR' },
      );
    }
    return auto;
  }

  const chosen = await db.academicYear.findUnique({ where: { id: toAcademicYearId } });
  if (!chosen) {
    throw Object.assign(new Error('That academic year does not exist'), { code: 'UNKNOWN_YEAR' });
  }
  // Later by DATE RANGE, matching how the current year is resolved, so a school
  // that skipped a year or labelled one oddly still compares correctly.
  if (chosen.startDate <= from.startDate) {
    throw Object.assign(
      new Error(
        `${chosen.label} is not after ${from.label}. Choose a later academic year — a move can only go forward.`,
      ),
      { code: 'YEAR_NOT_LATER' },
    );
  }
  return chosen;
};

/**
 * Resolve and validate the target class for a move.
 *
 * @param {object} db a Prisma client or transaction handle
 * @param {object} args
 * @param {object} args.source the class being moved out of (with its level)
 * @param {'promote'|'keep'} args.action
 * @param {string} [args.toClassId] the admin's chosen class id, if any
 * @returns {Promise<object>} `{ classId, label, levelId, order, levelName,
 *   willBeCreated }` — the same shape `nextClassFor` returns, so callers are
 *   unchanged whether the target was chosen or derived.
 */
const resolveTargetClass = async (db, { source, action, toClassId }) => {
  // A chosen class must be a real one. Never created on demand: an admin who
  // typed or picked a class means that class, and inventing it would silently
  // move a child into a class the school never opened.
  if (toClassId) {
    const chosen = await db.class.findUnique({ where: { id: toClassId }, include: { level: true } });
    if (!chosen) {
      throw Object.assign(new Error('That class does not exist'), { code: 'UNKNOWN_CLASS' });
    }
    return {
      classId: chosen.id,
      label: classLabel(chosen),
      levelId: chosen.levelId,
      order: chosen.level ? chosen.level.order : chosen.grade,
      levelName: chosen.level ? chosen.level.name : null,
      willBeCreated: false,
    };
  }

  // No choice: "keep" stays put, "promote" follows the level chain (today's
  // default, which may create the next class when the school never opened it).
  if (action === 'keep') {
    return {
      classId: source.id,
      label: classLabel(source),
      levelId: source.levelId,
      order: source.level ? source.level.order : source.grade,
      levelName: source.level ? source.level.name : null,
      willBeCreated: false,
    };
  }

  const target = await classesService.nextClassFor(source.id, { client: db });
  if (!target) {
    /* The top level graduates; a level with no successor needs one added first.
       Two different situations, so the admin is told which one. */
    const highestLevel = await db.gradeLevel.findFirst({ orderBy: { order: 'desc' } });
    const atTop = Boolean(highestLevel)
      && (source.level ? source.level.order : source.grade) >= highestLevel.order;
    throw Object.assign(
      new Error(atTop
        ? `${classLabel(source)} is the highest class in the school - mark it as passed out instead`
        : `${classLabel(source)} has no next level to promote into. Add the next level in Class Management first.`),
      { code: atTop ? 'CLASS_IS_TOP' : 'NO_NEXT_LEVEL' },
    );
  }
  return target;
};

/**
 * The shared per-student seat check: a child holds at most ONE seat per year.
 *
 * A move that would write a second seat for the same (student, year) is refused
 * here — before any write — so the caller can report which students would break
 * it. `existing` is the seat already on file for that year, if any.
 *
 * @returns {{ collides: boolean, seat: object|null }}
 */
const seatForYear = async (db, { studentId, academicYearId }) => {
  const seat = await db.studentEnrollment.findUnique({
    where: { studentId_academicYearId: { studentId, academicYearId } },
  });
  return { collides: Boolean(seat), seat };
};

/**
 * Promote a whole class into the next academic year. All of it, or none of it.
 *
 * Everything happens in ONE interactive transaction: the target class is created,
 * each student's new-year enrollment is written, their old row is closed, and the
 * current-class pointer on Student moves. A failure on student 30 of 40 leaves the
 * other 39 exactly as they were — which is the requirement, and also the only
 * honest option, because a half-promoted class produces two registers that both
 * claim to be real.
 *
 * The plan is RE-DERIVED inside the transaction rather than trusted from the
 * request. The screen was rendered before this call; a student could have been
 * added to, or removed from, the class in between, and promoting a roster the
 * admin never saw is exactly the silent auto-resolution the review screen exists
 * to prevent.
 *
 * ## Why `Student.rollNumber` is cleared
 *
 * A roll number identifies a seat in a class in a year, so carrying it upward
 * would be a lie about a new register — and it would very often collide outright,
 * since `@@unique([classId, rollNumber])` means the target class may already hold
 * the same number. The old number is not lost: it stays on the closed enrollment
 * row, which is where last year's register is read from.
 */
const promoteClass = async ({ classId, exclude = [], confirm = [], toAcademicYearId = null, toClassId = null }) => {
  const excludeSet = new Set(exclude);
  const confirmSet = new Set(confirm);

  /* A whole-class promotion over a remote database is a long transaction: the
     per-student identity check alone is a round trip each, before any write. The
     5s default was already close to the edge for a small class and tips over once
     the fee rows move too, so this transaction is explicitly given room. The work
     inside is still bounded and set-based wherever it can be. */
  return prisma.$transaction(async (tx) => {
    const source = await tx.class.findUnique({ where: { id: classId }, include: { level: true } });
    if (!source) throw Object.assign(new Error('Class not found'), { code: 'NOT_FOUND' });

    /* Re-derive the batch from the database, then apply the admin's decisions to
       THAT, so a student who joined the class after the review screen was rendered
       cannot slip through unconfirmed. */
    const batch = await liveStudentsOf(classId, tx);
    const chosen = withoutExcluded(batch, excludeSet);

    /* The promotion CYCLE is current-year → the chosen (or next) year. A student
       already moved into a later year — promoted, or "kept back" into the same
       class for the new year — holds a target-year seat, and that seat is the
       proof they must not be promoted twice. Without this filter a kept-back
       child (who stays on the class pointer, so `liveStudentsOf` still returns
       them) would be moved up two grades in one cycle. */
    const sourceYear = await currentYear(tx);
    if (!sourceYear) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });
    // The chosen year, validated by the SAME resolver the single-student move
    // uses. Absent → the year after the current one (today's default).
    const targetYear = await resolveTargetYear(tx, { from: sourceYear, toAcademicYearId });

    const included = chosen.filter(({ seat }) => !seat || seat.academicYearId === sourceYear.id);
    const alreadyHandled = chosen.filter(({ seat }) => seat && seat.academicYearId !== sourceYear.id);
    if (!included.length) {
      throw Object.assign(
        new Error('No students left to promote — every student has already been moved this cycle or was excluded'),
        { code: 'NOTHING_TO_PROMOTE' },
      );
    }

    /* The top class graduates; it must not be auto-promoted. Checked here rather
       than only in the UI, so a stale client cannot promote the graduating class
       into a grade the school does not run. An EXPLICITLY chosen class is exempt:
       if the admin picked a real class to move them into, that is a deliberate
       instruction (a school that runs Class 11, or a repeat), not the automatic
       "grade + 1" this guard exists to stop. */
    if (!toClassId) {
      const maxGrade = (await tx.class.findMany({ select: { grade: true } }))
        .reduce((max, c) => Math.max(max, c.grade), 0);
      if (source.grade >= maxGrade) {
        throw Object.assign(
          new Error(`${classLabel(source)} is the highest class in the school — mark it as passed out instead of promoting it`),
          { code: 'CLASS_IS_TOP' },
        );
      }
    }

    /* Nothing flagged may pass unconfirmed. Named individually, because "3 students
       need review" sends the admin hunting through a list they already scrolled
       past. */
    const unreviewed = [];
    for (const { student } of included) {
      if (confirmSet.has(student.id)) continue;
      const seen = identityOf(student);
      const rivals = await matchIdentity(observedOf(student), { excludeStudentIds: [student.id], client: tx });
      const duplicate = rivals.some((r) => r.tier === 'exact');
      const unverifiable = !seen.guardianName || !seen.contact;
      if (duplicate || unverifiable) unreviewed.push({ name: student.name, studentId: student.id, duplicate, unverifiable });
    }
    if (unreviewed.length) {
      throw Object.assign(
        new Error(`Confirm or exclude these students before promoting: ${unreviewed.map((u) => u.name).join(', ')}`),
        { code: 'UNREVIEWED_STUDENTS', unreviewed },
      );
    }

    /* The next class in the LEVEL CHAIN, not grade + 1: Nursery A promotes to LKG
       A, LKG A to UKG A, UKG A to Class 1 A. Or, when the admin chose one, that
       class. Resolved through the same shared resolver the single-student move
       uses, so a whole-class promotion, a single-student promotion and the review
       screen can never disagree about where a child goes. */
    const target = await resolveTargetClass(tx, { source, action: 'promote', toClassId });
    const targetId = target.classId;
    // A chosen class already exists, so this is only meaningful for the automatic
    // target: `nextClassFor` created it when the school never opened it. Kept so an
    // existing class is left exactly as it is, teacher included.
    await tx.class.upsert({
      where: { id: targetId },
      create: { id: targetId, grade: target.order, section: source.section, levelId: target.levelId, classTeacherId: null },
      update: {},
    });

    /* Belt-and-braces on the seat rule, checked before any write. In the ordinary
       case a student already holding a target-year seat is classified "already
       handled" by the filter above and never reaches here — but if that
       classification is ever widened, this still refuses the whole batch rather than
       letting a second seat be written. Offending names are reported together. */
    const duplicates = [];
    for (const { student } of included) {
      const { collides } = await seatForYear(tx, { studentId: student.id, academicYearId: targetYear.id });
      if (collides) duplicates.push(student.name);
    }
    if (duplicates.length) {
      throw Object.assign(
        new Error(
          `These students already have a record in ${targetYear.label}: ${duplicates.join(', ')}. `
          + 'Remove or undo those records before promoting.',
        ),
        { code: 'DUPLICATE_SEAT', duplicates },
      );
    }

    const moved = [];
    const feeTargets = [];
    for (const { student, seat } of included) {
      // The duplicate check above guarantees no target-year row exists, so this is
      // a plain create — the seat belongs to exactly one year, by construction.
      await tx.studentEnrollment.create({
        data: {
          studentId: student.id,
          academicYearId: targetYear.id,
          classId: targetId,
          rollNumber: null, // the office assigns the new register order
          status: 'active',
          source: 'promoted',
          enrolledOn: targetYear.startDate,
          promotedFromClassId: classId,
          // The batch was reviewed by a human, so the provenance of a match the
          // admin did not have to make is simply not applicable here.
          matchConfidence: null,
        },
      });

      /* Only the seat they actually held is closed. A child admitted before this
         feature has no seat to close, and one whose row was already closed must
         not have a second ending invented for it — the promotion is recorded once,
         in the year it happened. */
      if (seat) {
        await tx.studentEnrollment.update({
          where: { id: seat.id },
          data: { status: 'promoted', endedOn: seat.academicYear.endDate },
        });
      }

      await tx.student.update({
        where: { id: student.id },
        data: { classId: targetId, rollNumber: null },
      });

      /* Close the old year's fee and open the new one blank, in this same
         transaction. The old year's outstanding balance stays on its own row —
         that IS the previous dues carried forward. The actual writes are batched
         after the loop: doing them per student here is what pushed a class-sized
         promotion past the transaction timeout. */
      feeTargets.push({ studentId: student.id, toClassId: targetId });

      moved.push({ studentId: student.id, name: student.name });
    }

    await fees.rollFeeForwardBatch(tx, {
      fromYearId: sourceYear.id,
      toYearId: targetYear.id,
      targets: feeTargets,
    });

    return {
      kind: 'promoted',
      sourceClassId: classId,
      sourceClassLabel: classLabel(source),
      targetClassId: targetId,
      targetClassLabel: target.label,
      fromAcademicYearId: sourceYear.id,
      fromAcademicYearLabel: sourceYear.label,
      toAcademicYearId: targetYear.id,
      toAcademicYearLabel: targetYear.label,
      movedCount: moved.length,
      moved,
      alreadyHandledCount: alreadyHandled.length,
      excluded: batch
        .filter((b) => excludeSet.has(b.student.id))
        .map((b) => ({ studentId: b.student.id, name: b.student.name })),
    };
  }, { timeout: 60000, maxWait: 15000 });
};

/**
 * Graduate the top class: everyone in it leaves as an alumnus.
 *
 * Same all-or-nothing transaction as a promotion. The difference is entirely in the
 * bookkeeping — there is no next grade to move them to, so the current-class
 * pointer is set to NULL rather than repointed.
 *
 * That null is the whole mechanism, and it is why this needed no other change
 * anywhere in the app: a student with no current class is absent from every
 * `where: { classId }` roster filter and every `_count.students` headcount in the
 * codebase, because those queries were never taught about alumni — they simply
 * have nothing to match. The years they did attend stay fully readable through
 * their enrollment rows, which is what Class History reads.
 */
const passOutClass = async ({ classId }) => prisma.$transaction(async (tx) => {
  const source = await tx.class.findUnique({ where: { id: classId }, include: { level: true } });
  if (!source) throw Object.assign(new Error('Class not found'), { code: 'NOT_FOUND' });

  /* Whoever holds the class — NOT whoever once sat in it. Reading the enrollment
     rows for this class and year instead would sweep in every child already
     promoted out of it, so graduating a class twice would rewrite the year the
     first pass promoted them. `liveStudentsOf` follows the same pointer the
     headcount does, which is what makes this repeatable without consequence. */
  const batch = await liveStudentsOf(classId, tx);
  if (!batch.length) {
    throw Object.assign(new Error(`${classLabel(source)} has no students to pass out`), { code: 'NOTHING_TO_PASS_OUT' });
  }

  const passedOut = [];
  const passedOutAt = new Date();
  for (const { student, seat } of batch) {
    /* The seat ends at the end of the year it was for, not at the end of the year
       the button was pressed — the child sat that class for that whole year, and
       the calendar is the only thing that knows when it ended. `passedOutAt` is
       the separate event time the undo guard needs. */
    if (seat) {
      await tx.studentEnrollment.update({
        where: { id: seat.id },
        data: { status: 'passed_out', endedOn: seat.academicYear.endDate, passedOutAt },
      });
    }
    await tx.student.update({
      where: { id: student.id },
      // null, not the old class: keeping it would leave them on a current register
      // they have graduated from, and every roster in the app would show a ghost.
      data: { classId: null, rollNumber: null },
    });
    passedOut.push({ studentId: student.id, name: student.name });
  }

  return {
    kind: 'passed_out',
    sourceClassId: classId,
    sourceClassLabel: classLabel(source),
    passedOutCount: passedOut.length,
    students: passedOut,
  };
}, { timeout: 60000, maxWait: 15000 });

/* ═══════════════════════════════════════════════════════════════════════════
   Individual promotion — one student, from inside a class
   ═══════════════════════════════════════════════════════════════════════════ */

/** Which students already have attendance, marks or a payment in a year. */
const activityInYear = async (client, { studentIds, yearId, startDate, endDate }) => {
  if (!studentIds.length) return { attendance: new Set(), marks: new Set(), payments: new Set() };
  const [attendance, marks, payments] = await Promise.all([
    client.studentAttendance.findMany({
      where: { studentId: { in: studentIds }, date: { gte: startDate, lte: endDate } },
      select: { studentId: true },
      distinct: ['studentId'],
    }),
    client.marksEntry.findMany({
      where: { studentId: { in: studentIds }, exam: { academicYearId: yearId } },
      select: { studentId: true },
      distinct: ['studentId'],
    }),
    client.feePayment.findMany({
      where: { studentFee: { studentId: { in: studentIds }, academicYearId: yearId } },
      select: { studentFee: { select: { studentId: true } } },
    }),
  ]);
  return {
    attendance: new Set(attendance.map((r) => r.studentId)),
    marks: new Set(marks.map((r) => r.studentId)),
    payments: new Set(payments.map((r) => r.studentFee.studentId)),
  };
};

/**
 * Which students have attendance or marks written AFTER their own pass-out.
 *
 * `passedOutAt` is the event time, not `endedOn` (the year's last day). Seats
 * that predate the column have no event time, so they keep the old conservative
 * rule: any attendance or marks in the year closes the window. That is safer
 * than guessing from `updatedAt`, which later edits move.
 */
const activityAfterPassOut = async (client, { seats, yearId, startDate, endDate }) => {
  const blocked = new Set();

  const legacy = seats.filter((s) => !s.passedOutAt);
  if (legacy.length) {
    const old = await activityInYear(client, {
      studentIds: legacy.map((s) => s.studentId),
      yearId,
      startDate,
      endDate,
    });
    for (const id of old.attendance) blocked.add(id);
    for (const id of old.marks) blocked.add(id);
  }

  const dated = seats.filter((s) => s.passedOutAt);
  if (!dated.length) return blocked;

  const [attendance, marks] = await Promise.all([
    client.studentAttendance.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        OR: dated.map((s) => ({ studentId: s.studentId, recordedAt: { gt: s.passedOutAt } })),
      },
      select: { studentId: true },
      distinct: ['studentId'],
    }),
    client.marksEntry.findMany({
      where: {
        exam: { academicYearId: yearId },
        OR: dated.map((s) => ({
          studentId: s.studentId,
          OR: [
            { enteredAt: { gt: s.passedOutAt } },
            { updatedAt: { gt: s.passedOutAt } },
          ],
        })),
      },
      select: { studentId: true },
      distinct: ['studentId'],
    }),
  ]);
  for (const row of attendance) blocked.add(row.studentId);
  for (const row of marks) blocked.add(row.studentId);
  return blocked;
};

/**
 * The class's current-year register, with what has already happened to each child
 * this promotion cycle.
 *
 * Read from the YEAR'S ENROLLMENT ROWS, not `Student.classId`, on purpose: a
 * child who was moved individually still has a seat in this year's register —
 * closing that seat is how the year is preserved — so this is the only view from
 * which "3 of 20 already moved, 17 remaining" is a fact rather than a guess.
 *
 * `handled` means a target-year (or later) seat already exists, so the student
 * must not be moved again this cycle. `canUndo` is the mirror image: the move
 * can be reversed only while nothing has been recorded in the new year.
 */
const classPromotionRoster = async ({ classId }) => {
  const source = await prisma.class.findUnique({ where: { id: classId }, include: { level: true } });
  if (!source) throw Object.assign(new Error('Class not found'), { code: 'NOT_FOUND' });

  const overview = await classOverview();
  const from = overview.currentAcademicYear;
  const to = overview.nextAcademicYear;
  if (!from) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });
  if (!to) throw Object.assign(new Error('There is no academic year after the current one to promote into'), { code: 'NO_TARGET_YEAR' });

  /* The next class in the LEVEL CHAIN, with the same section. Read here rather
     than recomputed in the caller so the roster and the promotion agree. This is
     a PREVIEW: `create: false` resolves the destination id without writing it, so
     opening — and then cancelling — a review cannot leave an orphan class behind
     (QA-A1-017). The class is created only when the promotion is confirmed. */
  const nextTarget = await classesService.nextClassFor(classId, { create: false });
  const isTop = source.grade === overview.topGrade;
  const noNextLevel = !nextTarget && !isTop;
  const seats = await prisma.studentEnrollment.findMany({
    where: { academicYearId: from.id, classId },
    include: {
      student: {
        include: {
          enrollments: {
            where: { status: 'active' },
            include: { academicYear: true, class: { include: { level: true } } },
            orderBy: { academicYear: { startDate: 'desc' } },
          },
        },
      },
    },
    orderBy: [{ rollNumber: 'asc' }, { student: { name: 'asc' } }],
  });

  const studentIds = seats.map((s) => s.studentId);
  const targetActivity = await activityInYear(prisma, {
    studentIds,
    yearId: to.id,
    startDate: to.startDate,
    endDate: to.endDate,
  });
  const passedOutActivity = await activityAfterPassOut(prisma, {
    seats: seats.filter((s) => s.status === 'passed_out'),
    yearId: from.id,
    startDate: from.startDate,
    endDate: from.endDate,
  });

  const students = seats.map((seat) => {
    const student = seat.student;
    // The student's live seat. A later-year active seat means they were moved
    // into the new year already; anything else is still in this cycle.
    const laterSeat = student.enrollments.find((e) => e.academicYearId !== from.id) || null;
    const passedOut = seat.status === 'passed_out' && !student.classId;

    let state = 'active';
    let stateLabel = 'In this class';
    let handled = false;
    if (passedOut) {
      state = 'passed_out';
      stateLabel = 'Passed Out';
      handled = true;
    } else if (laterSeat) {
      handled = true;
      if (laterSeat.classId === classId) {
        state = 'kept';
        stateLabel = `Kept in ${classLabel(source)}`;
      } else {
        state = 'promoted';
        stateLabel = `Promoted to ${classLabel(laterSeat.class)}`;
      }
    }

    const blocked = passedOut
      ? passedOutActivity.has(student.id)
      : targetActivity.attendance.has(student.id)
        || targetActivity.marks.has(student.id)
        || targetActivity.payments.has(student.id);

    return {
      studentId: student.id,
      name: student.name,
      photo: student.photo,
      rollNumber: seat.rollNumber,
      parentName: student.parentName,
      guardianContact: student.guardianContact,
      status: seat.status,
      state,
      stateLabel,
      handled,
      canUndo: handled && !blocked,
      undoBlock: handled && blocked
        ? (passedOut
          ? (seat.passedOutAt
            ? 'Attendance or marks were recorded after the pass-out'
            : 'Attendance or marks exist for this year')
          : 'Attendance, marks or a fee payment exists for the new year')
        : null,
    };
  });

  const handledCount = students.filter((s) => s.handled).length;
  return {
    classId,
    label: classLabel(source),
    grade: source.grade,
    section: source.section,
    order: source.level ? source.level.order : source.grade,
    levelId: source.levelId,
    levelName: source.level ? source.level.name : null,
    isTop,
    fromAcademicYear: from,
    toAcademicYear: to,
    targetClass: isTop || !nextTarget ? null : nextTarget,
    totalCount: students.length,
    handledCount,
    remainingCount: students.length - handledCount,
    // Why there is no promote option: the top level graduates, or the level has
    // no successor and the admin can add one.
    noNextLevel,
    noNextLevelReason: isTop ? 'top' : (noNextLevel ? 'no_next_level' : null),
    students,
  };
};

const MOVE_ACTIONS = ['promote', 'keep', 'pass_out'];

/**
 * Move ONE student for the current promotion cycle, atomically.
 *
 * `promote` up a grade, `keep` in the same class for the new year, or
 * `pass_out` out of the school. All three share the fee rollover: the old year's
 * fee row is left with whatever it still owes (the carried-forward dues) and the
 * new year starts blank. A student already seated in a later year is refused, so
 * nobody is ever moved two grades in one cycle.
 *
 * The admin may CHOOSE the target year and target class. Omitting both keeps
 * today's behaviour exactly (the next year, the next class). The choice is
 * resolved and validated by `resolveTargetYear` / `resolveTargetClass`, the same
 * pair the whole-class move uses, so both entry points obey one rule.
 */
const moveStudent = async ({ studentId, action, toAcademicYearId = null, toClassId = null }) => {
  if (!MOVE_ACTIONS.includes(action)) {
    throw Object.assign(new Error(`Unknown action "${action}"`), { code: 'BAD_ACTION' });
  }

  return prisma.$transaction(async (tx) => {
    const student = await tx.student.findUnique({ where: { id: studentId } });
    if (!student) throw Object.assign(new Error('Student not found'), { code: 'NOT_FOUND' });
    if (!student.classId) {
      throw Object.assign(new Error('This student is not in a current class'), { code: 'NO_CURRENT_CLASS' });
    }

    const from = await currentYear(tx);
    if (!from) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });

    const source = await tx.class.findUnique({ where: { id: student.classId }, include: { level: true } });
    if (!source) throw Object.assign(new Error('Class not found'), { code: 'NOT_FOUND' });

    const laterSeat = await tx.studentEnrollment.findFirst({
      where: { studentId, status: 'active', academicYear: { startDate: { gt: from.startDate } } },
    });
    if (laterSeat) {
      throw Object.assign(
        new Error(`${student.name} has already been moved this cycle`),
        { code: 'ALREADY_HANDLED' },
      );
    }

    const seat = await tx.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId, academicYearId: from.id } },
    });

    if (action === 'pass_out') {
      if (seat) {
        await tx.studentEnrollment.update({
          where: { id: seat.id },
          data: { status: 'passed_out', endedOn: from.endDate, passedOutAt: new Date() },
        });
      }
      await tx.student.update({ where: { id: studentId }, data: { classId: null, rollNumber: null } });
      // No new year is opened, so there is nothing to roll: the year they left
      // remains their final fee record and its balance stays as previous dues.
      return {
        kind: 'passed_out',
        studentId,
        name: student.name,
        sourceClassLabel: classLabel(source),
      };
    }

    // The target year and class, chosen or defaulted — the SAME resolvers the
    // whole-class move uses, so a single promotion and a batch can never disagree.
    const to = await resolveTargetYear(tx, { from, toAcademicYearId });

    /* The target is the next LEVEL in the chain, the SAME class when keeping
       back, or a class the admin chose outright. All go through the shared
       resolver, which also creates the automatic next class when the school has
       never opened it. */
    const target = await resolveTargetClass(tx, { source, action, toClassId });
    const targetId = target.classId;

    /* One seat per (student, year). The move closes the OLD year's seat and opens
       the target year's; a seat already sitting in the TARGET year would be a
       second one, so it is refused rather than silently overwritten. (Re-running
       against the student's own current year cannot happen — that year is refused
       as "not later" first.) */
    const targetSeat = await seatForYear(tx, { studentId, academicYearId: to.id });
    if (targetSeat.collides) {
      throw Object.assign(
        new Error(
          `${student.name} already has a record in ${to.label}. Undo or remove that before moving them into it.`,
        ),
        { code: 'DUPLICATE_SEAT' },
      );
    }

    await tx.studentEnrollment.create({
      data: {
        studentId,
        academicYearId: to.id,
        classId: targetId,
        rollNumber: null,
        status: 'active',
        source: 'promoted',
        enrolledOn: to.startDate,
        promotedFromClassId: student.classId,
        matchConfidence: null,
      },
    });

    if (seat) {
      await tx.studentEnrollment.update({
        where: { id: seat.id },
        data: { status: 'promoted', endedOn: from.endDate },
      });
    }

    await tx.student.update({ where: { id: studentId }, data: { classId: targetId, rollNumber: null } });

    await fees.rollFeeForward(tx, {
      studentId,
      fromYearId: from.id,
      toYearId: to.id,
      toClassId: targetId,
    });

    return {
      kind: action === 'keep' ? 'kept' : 'promoted',
      studentId,
      name: student.name,
      sourceClassLabel: classLabel(source),
      // The target's own label, from the level chain - so a single-student
      // promotion reads "LKG A" exactly as the whole-class confirmation does.
      targetClassId: targetId,
      targetClassLabel: target.label,
      targetWillBeCreated: target.willBeCreated,
      fromAcademicYearId: from.id,
      fromAcademicYearLabel: from.label,
      toAcademicYearId: to.id,
      toAcademicYearLabel: to.label,
    };
  }, { timeout: 30000, maxWait: 10000 });
};

/**
 * Reverse ONE student's move, and only while the new year is untouched.
 *
 * The window closes the moment attendance or marks are recorded for the new year
 * — the rule stated to the school — and a fee payment closes it too, because
 * deleting a year's fee row would otherwise erase money that was really
 * received. Undo is deliberately single-student: a whole-class move is a
 * reviewed batch, and un-picking it one child at a time is what the per-student
 * controls are for.
 */
const undoStudentMove = async ({ studentId }) => prisma.$transaction(async (tx) => {
  const student = await tx.student.findUnique({ where: { id: studentId } });
  if (!student) throw Object.assign(new Error('Student not found'), { code: 'NOT_FOUND' });

  const from = await currentYear(tx);
  if (!from) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });

  const laterSeat = await tx.studentEnrollment.findFirst({
    where: { studentId, status: 'active', academicYear: { startDate: { gt: from.startDate } } },
    include: { academicYear: true, class: true },
  });

  if (!laterSeat) {
    // A pass-out leaves no later-year seat; the current-year seat is `passed_out`.
    const passed = await tx.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId, academicYearId: from.id } },
    });
    if (!passed || passed.status !== 'passed_out') {
      throw Object.assign(new Error('This student has not been moved this cycle'), { code: 'NOTHING_TO_UNDO' });
    }
    const blocked = await activityAfterPassOut(tx, {
      seats: [passed],
      yearId: from.id,
      startDate: from.startDate,
      endDate: from.endDate,
    });
    if (blocked.has(studentId)) {
      throw Object.assign(
        new Error(passed.passedOutAt
          ? 'Attendance or marks were recorded after the pass-out, so this cannot be undone'
          : 'Attendance or marks exist for this year, so this pass-out cannot be undone'),
        { code: 'UNDO_WINDOW_CLOSED' },
      );
    }
    await tx.studentEnrollment.update({
      where: { id: passed.id },
      data: { status: 'active', endedOn: null, passedOutAt: null },
    });
    await tx.student.update({
      where: { id: studentId },
      data: { classId: passed.classId, rollNumber: passed.rollNumber },
    });
    return { kind: 'undone_pass_out', studentId, name: student.name, classLabel: classLabel(passed.class) };
  }

  const targetYear = laterSeat.academicYear;
  const activity = await activityInYear(tx, {
    studentIds: [studentId],
    yearId: targetYear.id,
    startDate: targetYear.startDate,
    endDate: targetYear.endDate,
  });
  if (activity.attendance.has(studentId) || activity.marks.has(studentId)) {
    throw Object.assign(
      new Error('Attendance or marks have been recorded for the new year, so this move cannot be undone'),
      { code: 'UNDO_WINDOW_CLOSED' },
    );
  }

  const removedFee = await fees.removeUnpaidFeeYear(tx, { studentId, academicYearId: targetYear.id });
  if (!removedFee) {
    throw Object.assign(
      new Error('A fee payment has been recorded for the new year, so this move cannot be undone'),
      { code: 'UNDO_WINDOW_CLOSED' },
    );
  }

  const ascending = await tx.academicYear.findMany({ orderBy: { startDate: 'asc' } });
  const idx = ascending.findIndex((y) => y.id === targetYear.id);
  const sourceYear = idx > 0 ? ascending[idx - 1] : null;
  const sourceSeat = sourceYear
    ? await tx.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId, academicYearId: sourceYear.id } },
      include: { class: true },
    })
    : null;
  if (!sourceSeat) {
    throw Object.assign(new Error('Cannot find the class this student was moved from'), { code: 'NOTHING_TO_UNDO' });
  }

  await tx.studentEnrollment.delete({ where: { id: laterSeat.id } });
  await tx.studentEnrollment.update({
    where: { id: sourceSeat.id },
    data: { status: 'active', endedOn: null },
  });
  await tx.student.update({
    where: { id: studentId },
    data: { classId: sourceSeat.classId, rollNumber: sourceSeat.rollNumber },
  });
  await fees.syncStudentFeeCache(tx, studentId);

  return {
    kind: 'undone',
    studentId,
    name: student.name,
    undoneToAcademicYearLabel: targetYear.label,
    restoredClassId: sourceSeat.classId,
    restoredClassLabel: sourceSeat.class ? classLabel(sourceSeat.class) : null,
  };
}, { timeout: 30000, maxWait: 10000 });

/* ═══════════════════════════════════════════════════════════════════════════
   Enter Past Data — backfilling a historical year
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Find the student an identity triple belongs to, for attaching a historical
 * record to an existing child.
 *
 * The search is deliberately forgiving about FORM and strict about PEOPLE: it
 * finds "Rajesh  KUMAR" typed as "rajesh kumar" with the guardian's number written
 * three different ways, but it never decides on its own that two records are the
 * same child — that is what the returned tier is for, and why the caller is
 * expected to make the admin choose when it is anything but `exact`.
 *
 * Returns each candidate with enough context to tell two similar children apart:
 * which class they are in now, and which years they already have records for.
 */
const searchIdentity = async (observed) => {
  // `partial: true` — the admin is picking from a list, so a fragment of a name is
  // a useful hit and a contact with no name is a legitimate query.
  const matches = await matchIdentity(observed, { limit: 25, partial: true });
  if (!matches.length) return [];
  const ids = matches.map((m) => m.student.id);

  /* One pass for context, rather than a query per candidate. */
  const students = await prisma.student.findMany({
    where: { id: { in: ids } },
    include: {
      class: true,
      enrollments: { include: { academicYear: true, class: true }, orderBy: { academicYear: { startDate: 'desc' } } },
    },
  });
  const byId = new Map(students.map((s) => [s.id, s]));

  return matches
    .filter((m) => byId.has(m.student.id))
    .map(({ student, tier, agrees }) => {
      const full = byId.get(student.id);
      return {
        studentId: student.id,
        name: full.name,
        parentName: full.parentName,
        guardianContact: full.guardianContact,
        currentClassLabel: full.class ? classLabel(full.class) : null,
        hasCurrentClass: Boolean(full.classId),
        tier,
        agrees,
        // Where this child has already been recorded, so the admin can see whether
        // the year they are about to type is a gap or an existing entry.
        years: full.enrollments.map((e) => ({
          academicYearId: e.academicYearId,
          academicYearLabel: e.academicYear.label,
          classLabel: classLabel(e.class),
          status: e.status,
        })),
      };
    });
};

/**
 * Validate a historical record's attendance summary.
 *
 * `present + absent <= workingDays` rather than `==`: a real register leaves days
 * unaccounted for (holidays the school still marked as working, half-days, days
 * the child was on approved leave), and demanding exact equality would reject
 * honest data. The ceiling is still enforced, because days present exceeding days
 * worked is arithmetically impossible and always means a typo.
 *
 * All three or none: a summary of "0 present, 0 absent" is a real record (present
 * for every day), and null is the separate meaning "never backfilled".
 */
const checkAttendanceSummary = (attendance) => {
  if (attendance === undefined || attendance === null) return null;
  const keys = ['workingDays', 'daysPresent', 'daysAbsent'];
  const missing = keys.filter((k) => attendance[k] === undefined || attendance[k] === null);
  if (missing.length) {
    throw Object.assign(
      new Error(`Attendance needs all of ${keys.join(', ')} — got ${missing.join(' and ')} missing`),
      { code: 'INCOMPLETE_ATTENDANCE', field: missing[0] },
    );
  }
  const nums = {};
  keys.forEach((k) => {
    const n = Number(attendance[k]);
    if (!Number.isInteger(n) || n < 0) {
      throw Object.assign(new Error(`${k} must be a whole number of 0 or more`), { code: 'INVALID_ATTENDANCE', field: k });
    }
    nums[k] = n;
  });
  if (nums.daysPresent + nums.daysAbsent > nums.workingDays) {
    throw Object.assign(
      new Error(`Days present plus days absent (${nums.daysPresent + nums.daysAbsent}) cannot exceed working days (${nums.workingDays})`),
      { code: 'ATTENDANCE_EXCEEDS_TERM', field: 'daysPresent' },
    );
  }
  return nums;
};

/**
 * Save one student's historical record for one academic year: their class
 * membership, their attendance totals, and every exam result recorded for them.
 *
 * Atomic, like promotion. A historical record is the kind of thing that gets
 * retyped once and then trusted for years, so half of one must never exist.
 *
 * ## What it deliberately does NOT touch
 *
 * `Student.classId` and `Student.rollNumber`. Backfilling 2024-25 says nothing
 * about where a child is TODAY, so writing the past year onto the current-class
 * pointer would put them on a live register they may have left three years ago —
 * and for a child created here, who has never been in this school at all, would
 * invent a present they do not have. Both pointers are left exactly as they were;
 * a backfilled child simply holds no current class until an ordinary admission
 * gives them one.
 */
const saveHistoricalRecord = async ({
  academicYearId,
  classId,
  existingStudentId,
  newStudent,
  rollNumber,
  attendance,
  marks = [],
  actorUsername,
}) => prisma.$transaction(async (tx) => {
  const year = await tx.academicYear.findUnique({ where: { id: academicYearId } });
  if (!year) throw Object.assign(new Error('Academic year not found'), { code: 'NOT_FOUND' });
  const cls = await tx.class.findUnique({ where: { id: classId } });
  if (!cls) throw Object.assign(new Error('Class not found'), { code: 'NOT_FOUND' });

  const summary = checkAttendanceSummary(attendance);

  /* ── resolve the student ─────────────────────────────────────────────────── */
  let student;
  if (existingStudentId) {
    if (newStudent) throw Object.assign(new Error('Give either an existing student or a new one, not both'), { code: 'AMBIGUOUS_SUBJECT' });
    student = await tx.student.findUnique({ where: { id: existingStudentId } });
    if (!student) throw Object.assign(new Error('Student not found'), { code: 'NOT_FOUND' });
  } else {
    /* All three identity fields are REQUIRED here, and that is the point of the
       whole matching scheme: a record created without them cannot be matched to
       itself next year, and "we will add the guardian later" is how duplicate
       children get created in the first place. */
    const fields = ['name', 'parentName', 'guardianContact'];
    const missing = fields.filter((f) => !newStudent?.[f]);
    if (missing.length) {
      throw Object.assign(
        new Error(`A historical student needs ${fields.join(', ')} — these are how they will be matched in future years. Missing: ${missing.join(', ')}`),
        { code: 'MISSING_IDENTITY', field: missing[0] },
      );
    }
    /* The duplicate rule, unchanged. "Enter Past Data" creating a second record
       for a child who is already on file is exactly the failure the rule exists
       to stop, so it is refused here with the existing student named — the admin
       then attaches this year's record to that student instead of creating a
       twin. */
    const duplicates = await findDuplicateStudent(newStudent, { client: tx, limit: 1 });
    if (duplicates.length) {
      throw Object.assign(
        new Error(`${duplicateMessage(duplicates[0])} Attach this year's record to them instead of creating a new student.`),
        { code: 'DUPLICATE_IDENTITY', status: 409, duplicate: { studentId: duplicates[0].student.id } },
      );
    }
    student = await tx.student.create({
      data: {
        id: newStudentId(),
        name: String(newStudent.name).trim(),
        parentName: String(newStudent.parentName).trim(),
        guardianContact: String(newStudent.guardianContact).trim(),
        // No current class: this child is being recorded for a year that is over,
        // and until an ordinary admission assigns one they belong to no register.
        classId: null,
        rollNumber: null,
        // enrolledAt is NOT NULL with no default; the year start is the honest
        // floor for a record we are backfilling rather than observing.
        enrolledAt: year.startDate,
      },
    });
  }

  /* ── the year's class membership ────────────────────────────────────────── */
  const existing = await tx.studentEnrollment.findUnique({
    where: { studentId_academicYearId: { studentId: student.id, academicYearId } },
  });
  let enrollment;
  if (existing) {
    /* Updating in place is what makes a mistyped record fixable. Moving them to a
       different class for the same year is NOT allowed, because that would silently
       rewrite a year whose registers may already have marks filed against the
       class they were first put in. */
    if (existing.classId !== classId) {
      const was = await tx.class.findUnique({ where: { id: existing.classId } });
      throw Object.assign(
        new Error(`${student.name} is already recorded in ${was ? classLabel(was) : existing.classId} for ${year.label}. Delete that record first if the class was wrong.`),
        { code: 'ALREADY_RECORDED_IN_OTHER_CLASS', field: 'classId' },
      );
    }
    enrollment = await tx.studentEnrollment.update({
      where: { id: existing.id },
      data: {
        rollNumber: rollNumber ?? existing.rollNumber,
        workingDays: summary ? summary.workingDays : existing.workingDays,
        daysPresent: summary ? summary.daysPresent : existing.daysPresent,
        daysAbsent: summary ? summary.daysAbsent : existing.daysAbsent,
      },
    });
  } else {
    enrollment = await tx.studentEnrollment.create({
      data: {
        studentId: student.id,
        academicYearId,
        classId,
        rollNumber: rollNumber ?? null,
        status: 'active',
        // The distinction the spec asks for: this row was typed in afterwards, and
        // nothing in the app may let it be mistaken for a live register entry.
        source: 'historical',
        enrolledOn: year.startDate,
        workingDays: summary ? summary.workingDays : null,
        daysPresent: summary ? summary.daysPresent : null,
        daysAbsent: summary ? summary.daysAbsent : null,
      },
    });
  }

  /* ── exam results ───────────────────────────────────────────────────────── */
  /* One Exam row per (class, year, name) — which is exactly its unique key — so
     the three subjects of one test become three marks against ONE exam, not three
     exams. Existing exams are reused rather than re-created, because the key may
     already point at a live exam whose date must not be overwritten by a
     backfill that never knew it. */
  const examsByName = new Map();
  for (const m of marks) {
    const name = String(m.examName || '').trim();
    if (!name) throw Object.assign(new Error('Each mark row needs an exam name'), { code: 'MARK_MISSING_EXAM', field: 'examName' });
    if (examsByName.has(name)) continue;
    const found = await tx.exam.findUnique({
      where: { classId_academicYearId_name: { classId, academicYearId, name } },
    });
    if (found) {
      examsByName.set(name, found);
    } else {
      examsByName.set(name, await tx.exam.create({
        data: {
          id: newExamId(),
          classId,
          name,
          // A register often records the year of an exam but not the day. Left null
          // rather than invented — an invented date is a fact nobody actually knows,
          // and it would then sort as though it were real.
          date: m.examDate ? new Date(`${m.examDate}T00:00:00.000Z`) : null,
          academicYearId,
          source: 'historical',
        },
      }));
    }
  }

  const savedMarks = [];
  for (const m of marks) {
    const name = String(m.examName).trim();
    const subject = String(m.subject || '').trim();
    if (!subject) throw Object.assign(new Error(`The "${name}" row needs a subject`), { code: 'MARK_MISSING_SUBJECT', field: 'subject' });
    const maxMarks = Number(m.maxMarks);
    const obtained = Number(m.obtained);
    if (!Number.isInteger(maxMarks) || maxMarks <= 0) {
      throw Object.assign(new Error(`"${subject}" max marks must be a whole number above 0`), { code: 'MARK_BAD_MAX', field: 'maxMarks' });
    }
    if (!Number.isInteger(obtained) || obtained < 0 || obtained > maxMarks) {
      throw Object.assign(
        new Error(`"${subject}" obtained must be between 0 and ${maxMarks}`),
        { code: 'MARK_OUT_OF_RANGE', field: 'obtained' },
      );
    }
    const examId = examsByName.get(name).id;
    await tx.marksEntry.upsert({
      where: { studentId_examId_subject: { studentId: student.id, examId, subject } },
      create: {
        studentId: student.id,
        examId,
        subject,
        maxMarks,
        obtained,
        // The admin's login username, so a backfilled mark is attributed to whoever
        // typed it rather than looking unattributed or, worse, like a teacher's.
        enteredBy: actorUsername || null,
        enteredAt: new Date(),
      },
      // Deliberately NOT overwriting enteredBy/enteredAt: those record the first
      // time this result was filed, and a correction must not rewrite the history of
      // who entered it. The same split the live marks route makes. updatedBy/
      // updatedAt are stamped so a post-pass-out correction closes the undo window.
      update: { maxMarks, obtained, updatedBy: actorUsername || null, updatedAt: new Date() },
    });
    savedMarks.push({ examName: name, subject, maxMarks, obtained });
  }

  return {
    studentId: student.id,
    name: student.name,
    createdStudent: !existingStudentId,
    enrollmentId: enrollment.id,
    academicYearId,
    academicYearLabel: year.label,
    classLabel: classLabel(cls),
    rollNumber: enrollment.rollNumber,
    attendance: summary
      ? { workingDays: summary.workingDays, daysPresent: summary.daysPresent, daysAbsent: summary.daysAbsent }
      : null,
    marksSaved: savedMarks.length,
    exams: [...examsByName.keys()],
  };
}, { timeout: 60000, maxWait: 15000 });

/**
 * One student's data AS RECORDED FOR ONE ACADEMIC YEAR.
 *
 * Backs the year-scoped Student Profile that Class History opens. Every figure
 * here is filtered to the year and to the class they were in THAT year — not to
 * their current class, which is the mistake that would make last year's register
 * show this year's results.
 *
 * Attendance comes back as two clearly separated things, because they are not the
 * same kind of evidence:
 *
 *   daily        rows counted within the year's own date range. Authoritative for
 *                any year the school marked day to day, and absent for a backfilled
 *                year, which has no days at all.
 *   backfilled   the yearly totals typed into the enrollment. Null when never
 *                backfilled — deliberately not zero, because "absent every single
 *                day" and "we do not know" must never render identically.
 */
const studentYearView = async ({ studentId, academicYearId }) => {
  const student = await prisma.student.findUnique({ where: { id: studentId }, include: { class: true } });
  if (!student) throw Object.assign(new Error('Student not found'), { code: 'NOT_FOUND' });
  const year = await prisma.academicYear.findUnique({ where: { id: academicYearId } });
  if (!year) throw Object.assign(new Error('Academic year not found'), { code: 'NOT_FOUND' });

  const enrollment = await prisma.studentEnrollment.findUnique({
    where: { studentId_academicYearId: { studentId, academicYearId } },
    include: { class: true },
  });
  const thatClassId = enrollment ? enrollment.classId : null;

  const attendanceRows = await prisma.studentAttendance.findMany({
    where: { studentId, date: { gte: year.startDate, lte: year.endDate } },
    select: { status: true, session: true },
  });

  /* Group by status so the caller gets counts, not 400 rows to count itself. */
  const byStatus = { present: 0, absent: 0 };
  attendanceRows.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });

  /* Marks are reached through the EXAMS of that year for the class they were in
     that year. Filtering on the student's current class instead would show a
     promoted child's 2024-25 results from the 2026-27 register, or none at all. */
  const marks = thatClassId
    ? await prisma.marksEntry.findMany({
      where: { studentId, exam: { classId: thatClassId, academicYearId } },
      include: { exam: true },
      orderBy: [{ exam: { name: 'asc' } }, { subject: 'asc' }],
    })
    : [];

  /* The fee as it stood FOR THIS YEAR — the year's own record, not today's. A
     promoted child's 2026-27 page shows what they owed that year, which is what
     makes Class History answer "as it was then". */
  const feeRow = await prisma.studentFee.findUnique({
    where: { studentId_academicYearId: { studentId, academicYearId } },
    include: { class: true, payments: { orderBy: { paidOn: 'asc' } } },
  });
  const feePaid = feeRow ? feeRow.payments.reduce((sum, p) => sum + p.amount, 0) : 0;
  const feeClassLabel = feeRow && feeRow.class ? classLabel(feeRow.class) : null;

  return {
    student: {
      id: student.id,
      name: student.name,
      photo: student.photo,
      parentName: student.parentName,
      guardianContact: student.guardianContact,
      currentClassLabel: student.class ? classLabel(student.class) : null,
      hasCurrentClass: Boolean(student.classId),
    },
    fee: feeRow
      ? {
        total: feeRow.total,
        isSet: feeRow.total != null,
        paid: feePaid,
        balance: feeRow.total == null ? null : Math.max(0, feeRow.total - feePaid),
        classLabel: feeClassLabel,
        payments: feeRow.payments.map((p) => ({
          amount: p.amount,
          paidOn: p.paidOn.toISOString().slice(0, 10),
          note: p.note,
          recordedBy: p.recordedBy,
          chosenYear: p.chosenYear === true,
          // The year and class this payment settled are the fee row's own — a
          // payment made last week against last year's dues belongs to that year,
          // which is what makes Class History answer "as it was then".
          academicYearLabel: year.label,
          classLabel: feeClassLabel,
        })),
      }
      : { total: null, isSet: false, paid: 0, balance: null, classLabel: null, payments: [] },
    academicYear: {
      id: year.id,
      label: year.label,
      startDate: year.startDate.toISOString().slice(0, 10),
      endDate: year.endDate.toISOString().slice(0, 10),
    },
    enrollment: enrollment
      ? {
        id: enrollment.id,
        classLabel: classLabel(enrollment.class),
        classId: enrollment.classId,
        rollNumber: enrollment.rollNumber,
        status: enrollment.status,
        source: enrollment.source,
        matchConfidence: enrollment.matchConfidence,
        promotedFromClassId: enrollment.promotedFromClassId,
      }
      : null,
    attendance: {
      daily: {
        present: byStatus.present,
        absent: byStatus.absent,
        total: attendanceRows.length,
        // Null, not zero — no rows for a backfilled year is a fact about the DATA,
        // not about the child.
        recorded: attendanceRows.length > 0,
      },
      backfilled: enrollment && enrollment.workingDays !== null
        ? {
          workingDays: enrollment.workingDays,
          daysPresent: enrollment.daysPresent,
          daysAbsent: enrollment.daysAbsent,
        }
        : null,
    },
    marks: marks.map((m) => ({
      examName: m.exam.name,
      examDate: m.exam.date ? m.exam.date.toISOString().slice(0, 10) : null,
      examSource: m.exam.source,
      subject: m.subject,
      maxMarks: m.maxMarks,
      obtained: m.obtained,
      enteredBy: m.enteredBy,
    })),
  };
};

module.exports = {
  // identity
  normText,
  normSearch,
  normContact,
  identityOf,
  observedOf,
  gradeMatch,
  matchIdentity,
  findDuplicateStudent,
  duplicateMessage,
  identityLockKey,
  lockIdentity,
  titleCase,
  // years
  today,
  listYears,
  currentYear,
  yearForDate,
  nextYearAfter,
  // structure
  classOverview,
  classesForYear,
  rosterFor,
  syncLiveEnrollment,
  // promotion
  resolveTargetYear,
  resolveTargetClass,
  seatForYear,
  promotionOptions,
  promotionPlan,
  promoteClass,
  passOutClass,
  classPromotionRoster,
  moveStudent,
  undoStudentMove,
  // backfill
  searchIdentity,
  checkAttendanceSummary,
  saveHistoricalRecord,
  studentYearView,
};
