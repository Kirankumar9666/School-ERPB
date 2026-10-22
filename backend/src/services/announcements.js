/**
 * Announcements: one table, three ways of addressing a circular, and one
 * recipient rule that the server owns.
 *
 * `Announcement.targetScope` decides who may read a row:
 *   ROLES     — the classic broad "Audience" send: every logged-in user whose
 *               Role is in `targetRoles` (admin/teacher/accountant/…).
 *   CLASS     — a targeted send to the students of exactly one class
 *               (`targetClassId`). Teachers may only target classes they are
 *               actually assigned to teach (enforced here, not in the UI).
 *   EMPLOYEES — a targeted send to every employee (teacher / accountant /
 *               librarian). Admin-only, deliberately.
 *
 * The recipient rule lives in `announcementRecipients()` below and is applied
 * by the read endpoints, so a targeted circular physically cannot be returned
 * to somebody outside its audience — the client never gets to decide that, and
 * nothing depends on the UI having filtered correctly.
 */
const { AnnouncementScope } = require('@prisma/client');
const { z } = require('zod');
const { ROLES, EMPLOYEE_ROLES } = require('../constants/roles');
const { ANNOUNCEMENT_CATEGORIES } = require('../constants/options');
const prisma = require('./prisma');
const { toDateStr, toIso, schoolToday, classLabel } = require('./mappers');
const { teacherTeachesClass } = require('./timetableScope');
const { apiDate } = require('./attendance');
const { sendDocumentPdf, docNameFrom } = require('./documents');

const newId = (prefix) => `${prefix}-${Date.now()}`;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * Scopes a caller may pick in the "Send To…" popup. ROLES is deliberately not
 * offered here: it is the separate broad Audience publish, which stays
 * admin-only, so a teacher can never reach every student in the school by
 * accident through the targeted flow.
 */
const TARGETED_SCOPES = [AnnouncementScope.CLASS, AnnouncementScope.EMPLOYEES];

/** Fields both flows share: title, body, category and the show window. */
const baseFields = {
  title: z.string().min(3).max(200),
  body: z.string().min(10),
  category: z.enum(ANNOUNCEMENT_CATEGORIES),
  // Omitted on create → the circular is visible from today (server date).
  showFrom: dateStr.optional(),
  // Required: after this day the circular stops appearing everywhere.
  showUntil: dateStr,
};

/**
 * Audience tags as a real array.
 *
 * A JSON body always sends an array, but a multipart form sends ONE field per
 * tag (`targetRoles=student&targetRoles=teacher`), so an admin who picks a
 * single audience tag produces a bare string here. Normalizing first means
 * both transports accept the same shapes and neither can be rejected purely
 * because of how the client encoded the list.
 */
const roleList = z.preprocess(
  (v) => (v === undefined || v === null || v === '' ? v : Array.isArray(v) ? v : [v]),
  z.array(z.enum(Object.values(ROLES))).min(1)
);

/** Broad Audience publish (admin) — the audience tags come from the request. */
const announcementSchema = z.object({
  ...baseFields,
  targetRoles: roleList,
});

/**
 * Targeted "Send To…" — the scope decides the audience, so the request may NOT
 * name roles itself. That is what stops a caller from widening their own
 * targeted send by posting a hand-crafted payload.
 */
const targetedAnnouncementSchema = z.object({
  ...baseFields,
  targetScope: z.enum(TARGETED_SCOPES),
  targetClassId: z.string().min(1).optional(),
});

/**
 * The employee-portal push schema — deliberately narrower than the admin's
 * `targetedAnnouncementSchema`: the only scope a teacher may name is CLASS.
 * Sending to all employees is not "hidden" for them, it is not expressible, so
 * a crafted `targetScope: 'EMPLOYEES'` fails zod validation before any service
 * code runs.
 */
const teacherTargetedSchema = z.object({
  ...baseFields,
  targetScope: z.literal(AnnouncementScope.CLASS),
  targetClassId: z.string().min(1, 'A class is required'),
});

/** The role tags a targeted scope resolves to, derived server-side. */
const rolesForScope = (scope) => {
  if (scope === AnnouncementScope.CLASS) return [ROLES.STUDENT];
  if (scope === AnnouncementScope.EMPLOYEES) return [...EMPLOYEE_ROLES];
  return [];
};

/**
 * A failure the route layer turns into the right HTTP status. Keeping it typed
 * means the scoping rules below can `throw` instead of threading a `res` object
 * through pure logic.
 */
class AnnouncementError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', fieldErrors = null } = {}) {
    super(message);
    this.name = 'AnnouncementError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * The audience of a targeted scope, verified against the real tables.
 *
 * - CLASS: the class must exist, and — unless the sender is an admin — it must
 *   be one of the teacher's own assignments. A teacher naming somebody else's
 *   class is rejected with 403 even when the request never went through the UI.
 * - EMPLOYEES: there is no per-employee list to check, but the blast radius is
 *   every employee in the school, so only an admin may do it. Asserted here as
 *   well as at the route, so calling the service directly cannot skip it.
 *
 * @param {object} sender  REQUIRED `{ role, employeeId, name }` — the pushing
 *   user. Required rather than optional so no caller can omit it and thereby
 *   skip the permission checks below.
 * @returns {Promise<{targetClassId: string|null, studentCount: number|null, employeeCount: number|null}>}
 */
const resolveAudience = async ({ scope, targetClassId, sender }) => {
  if (scope === AnnouncementScope.CLASS) {
    if (!targetClassId) {
      throw new AnnouncementError('Choose a class to send to.', {
        status: 400, code: 'VALIDATION_ERROR', fieldErrors: { targetClassId: ['A class is required'] },
      });
    }
    const klass = await prisma.class.findUnique({
      where: { id: targetClassId },
      include: { _count: { select: { students: true } }, level: true },
    });
    if (!klass) throw new AnnouncementError('Class not found', { status: 404, code: 'NOT_FOUND' });

    // Teachers may only reach classes they have a period in; admins may target
    // any class. The gate is the shared timetable-scope rule, so it admits
    // exactly the classes the push picker lists.
    if (sender.role !== ROLES.ADMIN && !(await teacherTeachesClass(sender.employeeId, klass.id))) {
      throw new AnnouncementError('This class is not assigned to you', { status: 403, code: 'FORBIDDEN' });
    }
    return {
      targetClassId: klass.id,
      // The shared name function — the circular PDF says "Nursery A", not
      // "Class -2A", and it says exactly what the audience dropdown said.
      classLabel: classLabel(klass),
      studentCount: klass._count.students,
      employeeCount: null,
    };
  }

  if (scope === AnnouncementScope.EMPLOYEES) {
    if (sender.role !== ROLES.ADMIN) {
      throw new AnnouncementError('Only the admin can send an announcement to all employees', {
        status: 403, code: 'FORBIDDEN',
      });
    }
    const employeeCount = await prisma.employee.count();
    return { targetClassId: null, classLabel: null, studentCount: null, employeeCount };
  }

  throw new AnnouncementError('Unsupported announcement scope', { status: 400, code: 'BAD_REQUEST' });
};

/**
 * Create one announcement row, targeted or broad, with an optional PDF
 * attachment. The audience is resolved (and permission-checked) here so the
 * stored row is always self-consistent: the roles on the row are exactly the
 * audience that may read it.
 *
 * @param {object} input  validated zod payload
 * @param {object} opts
 * @param {'AnnouncementScope'} [opts.scope]  ROLES for the broad Audience
 *   publish (default), CLASS / EMPLOYEES for a targeted "Send To…".
 * @param {object|null} [opts.file]  multer file, already MIME/magic-byte
 *   validated by the route.
 * @param {object} opts.sender  REQUIRED `{ role, employeeId, name }` of the
 *   pushing user. `employeeId` is null for an admin (no employee row); when it
 *   is set the announcement is attributed to that employee.
 * @returns {Promise<{ row: object, studentCount: number|null, employeeCount: number|null }>}
 */
const createAnnouncement = async (input, { scope = AnnouncementScope.ROLES, file = null, sender } = {}) => {
  if (!sender || !sender.role) {
    throw new AnnouncementError('Sender identity is required', { status: 500, code: 'SERVER_ERROR' });
  }

  // "Show from" left blank → visible from today (the real current school date).
  const showFrom = input.showFrom || schoolToday();
  if (showFrom > input.showUntil) {
    throw new AnnouncementError('Show until must be on or after Show from.', {
      status: 400, code: 'VALIDATION_ERROR', fieldErrors: { showUntil: ['Show until must be on or after Show from.'] },
    });
  }

  let targetClassId = null;
  let targetRoles = input.targetRoles;
  let studentCount = null;
  let employeeCount = null;
  let classLabel = null;

  const author = sender.employeeId ? { id: sender.employeeId, name: sender.name || null } : null;

  if (scope === AnnouncementScope.ROLES) {
    targetClassId = null;
  } else {
    const audience = await resolveAudience({ scope, targetClassId: input.targetClassId, sender });
    targetClassId = audience.targetClassId;
    classLabel = audience.classLabel;
    studentCount = audience.studentCount;
    employeeCount = audience.employeeCount;
    targetRoles = rolesForScope(scope);
  }

  if (!Array.isArray(targetRoles) || targetRoles.length === 0) {
    throw new AnnouncementError('Pick at least one audience.', {
      status: 400, code: 'VALIDATION_ERROR', fieldErrors: { targetRoles: ['At least one audience is required'] },
    });
  }

  const row = await prisma.announcement.create({
    data: {
      id: newId('ann'),
      title: input.title,
      body: input.body,
      category: input.category,
      targetRoles,
      targetScope: scope,
      targetClassId,
      createdById: author ? author.id : null,
      attributedTo: author ? author.name : null,
      pdfFileName: file ? docNameFrom(file) : null,
      pdfData: file ? file.buffer : null,
      showFrom: apiDate(showFrom),
      showUntil: apiDate(input.showUntil),
    },
    // The created row is handed straight to `mapAnnouncementAdmin`, so the
    // class label and author relations have to come back with it.
    include: {
      targetClass: { select: { id: true, grade: true, section: true, level: { select: { name: true, order: true } } } },
      createdBy: { select: { id: true, name: true } },
    },
  });

  return { row, studentCount, employeeCount, classLabel };
};

/**
 * Which audiences may read this announcement — the single source of truth for
 * recipient scoping, shared by the portal feed and the PDF download endpoint.
 *
 * Pure: takes the stored row plus the viewer's identity, so it is directly
 * unit-testable and both readers can never drift apart.
 *
 * @param {object} a  the announcement row (needs targetScope/targetRoles/targetClassId)
 * @param {object} viewer  `{ role, studentClassId, employeeId }`
 */
const canRead = (a, viewer) => {
  // The author keeps access to what they sent, so a teacher can still re-read
  // (and re-download the attachment of) their own push. Checked before the
  // scope rules so a class push stays readable to the teacher who made it.
  if (a.createdById && viewer.employeeId && a.createdById === viewer.employeeId) return true;

  if (a.targetScope === AnnouncementScope.CLASS) {
    // Students of that one class — and nobody else, not even other students.
    return viewer.role === ROLES.STUDENT && Boolean(a.targetClassId) && a.targetClassId === viewer.studentClassId;
  }
  if (a.targetScope === AnnouncementScope.EMPLOYEES) {
    return EMPLOYEE_ROLES.includes(viewer.role);
  }
  return a.targetRoles.includes(viewer.role);
};

/**
 * Narrow a set of announcement rows down to the ones this viewer may read.
 * Rows are filtered in memory because the show-window filter already runs in
 * memory (see school.routes.js) and the recipient rule needs the viewer's own
 * class, which a single `where` clause would have to re-derive per scope.
 */
const announcementRecipients = (rows, viewer) => rows.filter((a) => canRead(a, viewer));

/** Reject with the right status when a viewer may not read this row. */
const assertCanRead = (row, viewer) => {
  if (!row) throw new AnnouncementError('Announcement not found', { status: 404, code: 'NOT_FOUND' });
  if (!canRead(row, viewer)) {
    throw new AnnouncementError('Announcement not found', { status: 404, code: 'NOT_FOUND' });
  }
  return row;
};

/**
 * Resolve the viewer's identity for `canRead`: a student's class comes from the
 * real Student row behind their user, so a targeted class send lands on the
 * actual class membership (not on anything the client claims).
 *
 * @returns {Promise<{role: string, studentClassId: string|null, employeeId: string|null}>}
 */
const viewerIdentity = async (user) => {
  if (user.role !== ROLES.STUDENT) {
    return { role: user.role, studentClassId: null, employeeId: user.linkedEntityId || null };
  }
  const student = await prisma.student.findUnique({
    where: { id: user.linkedEntityId || '' },
    select: { classId: true },
  });
  return { role: user.role, studentClassId: student ? student.classId : null, employeeId: null };
};

/**
 * Shared `select` for every announcement list response. `pdfData` is
 * deliberately absent — the bytes must never ship in a list; `hasAttachment` is
 * derived from the stored name instead (a row only has one when both are set).
 */
const announcementListSelect = {
  id: true, title: true, body: true, targetRoles: true, category: true,
  createdAt: true, showFrom: true, showUntil: true,
  pdfFileName: true, targetScope: true, targetClassId: true,
  createdById: true, attributedTo: true,
  targetClass: { select: { id: true, grade: true, section: true, level: { select: { name: true, order: true } } } },
  createdBy: { select: { id: true, name: true } },
};

/** Admin list shape — includes who it was sent to. */
const mapAnnouncementAdmin = (a) => ({
  id: a.id,
  title: a.title,
  body: a.body,
  targetRoles: a.targetRoles,
  category: a.category,
  createdAt: toIso(a.createdAt),
  showFrom: toDateStr(a.showFrom),
  showUntil: toDateStr(a.showUntil),
  hasAttachment: Boolean(a.pdfFileName),
  attachmentName: a.pdfFileName || null,
  targetScope: a.targetScope,
  targetClassId: a.targetClassId || null,
  targetClassLabel: classLabel(a.targetClass),
  authorName: a.attributedTo || a.createdBy?.name || null,
  isTeacherPush: Boolean(a.createdById),
});

/** Portal feed shape — what a recipient may know, nothing more. */
const mapAnnouncementPublic = (a) => ({
  id: a.id,
  title: a.title,
  body: a.body,
  // Kept from the original feed shape: the audience tags this circular was
  // published to (the viewer is guaranteed to be in it already).
  targetRoles: a.targetRoles,
  category: a.category,
  createdAt: toIso(a.createdAt),
  hasAttachment: Boolean(a.pdfFileName),
  attachmentName: a.pdfFileName || null,
  targetScope: a.targetScope,
  targetClassLabel: classLabel(a.targetClass),
  // Present when an employee pushed it, so viewers can see who it came from.
  authorName: a.attributedTo || a.createdBy?.name || null,
  fromTeacher: Boolean(a.createdById),
});

/**
 * Serve an announcement's PDF. Callers must have run `assertCanRead` first —
 * a targeted circular's attachment follows exactly the same audience rule as
 * its body, so an out-of-audience id is a plain 404 rather than a live file.
 */
const sendAnnouncementPdf = (res, row) => {
  if (!row.pdfData) {
    throw new AnnouncementError('No attachment on this announcement', { status: 404, code: 'NO_FILE' });
  }
  return sendDocumentPdf(res, { fileName: row.pdfFileName, data: row.pdfData });
};

module.exports = {
  AnnouncementScope,
  TARGETED_SCOPES,
  AnnouncementError,
  announcementSchema,
  targetedAnnouncementSchema,
  teacherTargetedSchema,
  rolesForScope,
  resolveAudience,
  canRead,
  announcementRecipients,
  assertCanRead,
  viewerIdentity,
  announcementListSelect,
  createAnnouncement,
  mapAnnouncementAdmin,
  mapAnnouncementPublic,
  sendAnnouncementPdf,
};
