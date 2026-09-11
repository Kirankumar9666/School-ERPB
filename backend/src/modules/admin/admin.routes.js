const express = require('express');
const { z } = require('zod');
const bcrypt = require('bcryptjs');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES } = require('../../constants/roles');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');
const { MOCK_USERS } = require('../../mock/users');
const { MOCK_STUDENTS, MOCK_MARKS, MOCK_ACHIEVEMENTS, MOCK_ATTENDANCE_STUDENT } = require('../../mock/students');
const { MOCK_EMPLOYEES, MOCK_LEAVES, MOCK_DOCUMENTS, MOCK_ATTENDANCE_EMPLOYEE } = require('../../mock/employees');
const { MOCK_ANNOUNCEMENTS, MOCK_HOLIDAYS, MOCK_TIMETABLE, MOCK_SYLLABUS } = require('../../mock/school');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole([ROLES.ADMIN])); // All admin routes require ADMIN role

/* ---------- helpers ---------- */

/** Generate a unique mock id */
const newId = (prefix) => `${prefix}-${Date.now()}`;

/** ISO date regex */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/* ---------- Students CRUD ---------- */

const studentSchema = z.object({
  name: z.string().min(2).max(100),
  class: z.string().min(1).max(2),
  section: z.string().length(1),
  rollNumber: z.string().min(1).max(50).optional(),
  parentName: z.string().min(2).max(100).optional(),
  guardianContact: z.string().min(5).max(25).optional(),
  address: z.string().min(5).max(300).optional(),
  admissionYear: z.number().int().min(1990).max(2100).optional(),
  bloodGroup: z.string().max(5).optional(),
  dob: dateStr.optional(),
  feeTotal: z.number().min(0).optional(),
  feeDues: z.number().min(0).optional(),
});

/** GET /api/v1/admin/students — list all students */
router.get('/students', (req, res) => sendSuccess(res, MOCK_STUDENTS));

/** POST /api/v1/admin/students — create student */
router.post('/students', (req, res) => {
  const parsed = studentSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const newStudent = {
    id: newId('stu'),
    userId: null,
    photo: null,
    ...parsed.data,
  };
  MOCK_STUDENTS.push(newStudent);
  return sendSuccess(res, newStudent, 'Student created', 201);
});

/** PUT /api/v1/admin/students/:id — update student */
router.put('/students/:id', (req, res) => {
  const parsed = studentSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const student = MOCK_STUDENTS.find((s) => s.id === req.params.id);
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  Object.assign(student, parsed.data);
  return sendSuccess(res, student, 'Student updated');
});

/** DELETE /api/v1/admin/students/:id */
router.delete('/students/:id', (req, res) => {
  const idx = MOCK_STUDENTS.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const [removed] = MOCK_STUDENTS.splice(idx, 1);
  return sendSuccess(res, { id: removed.id }, 'Student deleted');
});

/* ---------- Employees CRUD ---------- */

const employeeSchema = z.object({
  name: z.string().min(2).max(100),
  employeeId: z.string().min(1).max(50).optional(),
  gender: z.enum(['Male', 'Female', 'Other']).optional(),
  dob: dateStr.optional(),
  bloodGroup: z.string().max(5).optional(),
  mobile: z.string().min(5).max(25).optional(),
  email: z.string().email().optional(),
  address: z.string().min(5).max(300).optional(),
  emergencyContact: z.string().min(5).max(25).optional(),
  department: z.string().min(1).max(100).optional(),
  designation: z.string().min(1).max(100).optional(),
  role: z.enum(EMPLOYEE_ROLES).optional(),
  qualification: z.string().max(200).optional(),
  dateOfJoining: dateStr.optional(),
  experience: z.string().max(50).optional(),
  reportingPrincipal: z.string().max(100).optional(),
  employmentType: z.enum(['Permanent', 'Contract', 'Probation', 'Temporary']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/** GET /api/v1/admin/employees — list all employees */
router.get('/employees', (req, res) => sendSuccess(res, MOCK_EMPLOYEES));

/** POST /api/v1/admin/employees — create employee */
router.post('/employees', (req, res) => {
  const parsed = employeeSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const newEmployee = {
    id: newId('emp'),
    userId: null,
    photo: null,
    assignedClasses: [],
    ...parsed.data,
  };
  MOCK_EMPLOYEES.push(newEmployee);
  return sendSuccess(res, newEmployee, 'Employee created', 201);
});

/** PUT /api/v1/admin/employees/:id — update employee */
router.put('/employees/:id', (req, res) => {
  const parsed = employeeSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const employee = MOCK_EMPLOYEES.find((e) => e.id === req.params.id);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  Object.assign(employee, parsed.data);
  return sendSuccess(res, employee, 'Employee updated');
});

/** DELETE /api/v1/admin/employees/:id */
router.delete('/employees/:id', (req, res) => {
  const idx = MOCK_EMPLOYEES.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  const [removed] = MOCK_EMPLOYEES.splice(idx, 1);
  return sendSuccess(res, { id: removed.id }, 'Employee deleted');
});

/* ---------- Leaves ---------- */

/** GET /api/v1/admin/leaves/pending — list all pending leave applications */
router.get('/leaves/pending', (req, res) => {
  const pending = [];
  Object.entries(MOCK_LEAVES).forEach(([empId, data]) => {
    const employee = MOCK_EMPLOYEES.find((e) => e.id === empId);
    data.history
      .filter((l) => l.status === 'pending')
      .forEach((leave) => {
        pending.push({ ...leave, employeeId: empId, employeeName: employee?.name });
      });
  });
  return sendSuccess(res, pending);
});

/** PUT /api/v1/admin/leaves/:leaveId/status — approve or reject a leave */
const leaveStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
});

router.put('/leaves/:leaveId/status', (req, res) => {
  const parsed = leaveStatusSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { leaveId } = req.params;
  const { status } = parsed.data;

  let updated = false;
  Object.values(MOCK_LEAVES).forEach((data) => {
    const leave = data.history.find((l) => l.id === leaveId);
    if (leave) {
      leave.status = status;
      updated = true;
    }
  });

  if (!updated) return sendError(res, 'Leave record not found', 404, 'NOT_FOUND');
  return sendSuccess(res, null, `Leave ${status} successfully`);
});

/* ---------- Announcements ---------- */

const announcementSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().min(10),
  targetRoles: z.array(z.string()).min(1),
  category: z.enum(['event', 'exam', 'holiday', 'meeting', 'general']),
});

/** GET /api/v1/admin/announcements — list all (admin sees everything) */
router.get('/announcements', (req, res) => sendSuccess(res, MOCK_ANNOUNCEMENTS));

/** POST /api/v1/admin/announcements — create new announcement */
router.post('/announcements', (req, res) => {
  const parsed = announcementSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const newAnnouncement = {
    id: newId('ann'),
    ...parsed.data,
    createdAt: new Date().toISOString(),
  };
  MOCK_ANNOUNCEMENTS.unshift(newAnnouncement);
  return sendSuccess(res, newAnnouncement, 'Announcement created', 201);
});

/** PUT /api/v1/admin/announcements/:id — update announcement */
router.put('/announcements/:id', (req, res) => {
  const parsed = announcementSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const announcement = MOCK_ANNOUNCEMENTS.find((a) => a.id === req.params.id);
  if (!announcement) return sendError(res, 'Announcement not found', 404, 'NOT_FOUND');

  Object.assign(announcement, parsed.data);
  return sendSuccess(res, announcement, 'Announcement updated');
});

/** DELETE /api/v1/admin/announcements/:id */
router.delete('/announcements/:id', (req, res) => {
  const idx = MOCK_ANNOUNCEMENTS.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return sendError(res, 'Announcement not found', 404, 'NOT_FOUND');

  const [removed] = MOCK_ANNOUNCEMENTS.splice(idx, 1);
  return sendSuccess(res, { id: removed.id }, 'Announcement deleted');
});

/* ---------- Holidays ---------- */

const holidaySchema = z.object({
  date: dateStr,
  name: z.string().min(2).max(100),
});

/** GET /api/v1/admin/holidays — list all */
router.get('/holidays', (req, res) => sendSuccess(res, MOCK_HOLIDAYS));

/** POST /api/v1/admin/holidays — add a holiday */
router.post('/holidays', (req, res) => {
  const parsed = holidaySchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const newHoliday = { id: newId('hol'), ...parsed.data };
  MOCK_HOLIDAYS.push(newHoliday);
  return sendSuccess(res, newHoliday, 'Holiday added', 201);
});

/** DELETE /api/v1/admin/holidays/:id */
router.delete('/holidays/:id', (req, res) => {
  const idx = MOCK_HOLIDAYS.findIndex((h) => h.id === req.params.id);
  if (idx === -1) return sendError(res, 'Holiday not found', 404, 'NOT_FOUND');

  const [removed] = MOCK_HOLIDAYS.splice(idx, 1);
  return sendSuccess(res, { id: removed.id }, 'Holiday deleted');
});

/* ---------- Attendance ---------- */

const attendanceSchema = z.object({
  entityType: z.enum(['student', 'employee']),
  entityId: z.string().min(1),
  date: dateStr,
  status: z.enum(['present', 'absent', 'late', 'half-day', 'holiday']),
  workingHours: z.number().min(0).max(24).optional(),
});

/** POST /api/v1/admin/attendance — mark attendance for a student or employee */
router.post('/attendance', (req, res) => {
  const parsed = attendanceSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { entityType, entityId, date, status, workingHours } = parsed.data;
  const month = date.slice(0, 7);

  if (entityType === 'student') {
    const student = MOCK_STUDENTS.find((s) => s.id === entityId);
    if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');
    if (!MOCK_ATTENDANCE_STUDENT[entityId]) MOCK_ATTENDANCE_STUDENT[entityId] = {};
    if (!MOCK_ATTENDANCE_STUDENT[entityId][month]) MOCK_ATTENDANCE_STUDENT[entityId][month] = {};
    MOCK_ATTENDANCE_STUDENT[entityId][month][date] = status;
  } else {
    const employee = MOCK_EMPLOYEES.find((e) => e.id === entityId);
    if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');
    if (!MOCK_ATTENDANCE_EMPLOYEE[entityId]) MOCK_ATTENDANCE_EMPLOYEE[entityId] = {};
    if (!MOCK_ATTENDANCE_EMPLOYEE[entityId][month]) MOCK_ATTENDANCE_EMPLOYEE[entityId][month] = {};
    MOCK_ATTENDANCE_EMPLOYEE[entityId][month][date] = { status, workingHours: workingHours || (status === 'present' ? 8 : 0) };
  }

  return sendSuccess(res, { entityType, entityId, date, status }, 'Attendance marked', 201);
});

/* ---------- Marks ---------- */

const marksSchema = z.object({
  studentId: z.string().min(1),
  examName: z.string().min(2).max(100),
  date: dateStr.optional(),
  subjects: z.array(z.object({
    subject: z.string().min(1),
    maxMarks: z.number().min(1),
    obtained: z.number().min(0),
  })).min(1),
});

/** POST /api/v1/admin/marks — upload marks for a student/exam */
router.post('/marks', (req, res) => {
  const parsed = marksSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const student = MOCK_STUDENTS.find((s) => s.id === parsed.data.studentId);
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const newExam = { examId: newId('exam'), ...parsed.data };
  if (!MOCK_MARKS[student.id]) MOCK_MARKS[student.id] = [];
  MOCK_MARKS[student.id].push(newExam);
  return sendSuccess(res, newExam, 'Marks uploaded', 201);
});

/** GET /api/v1/admin/marks?studentId= — list marks */
router.get('/marks', (req, res) => {
  const { studentId } = req.query;
  if (studentId) return sendSuccess(res, MOCK_MARKS[studentId] || []);
  return sendSuccess(res, MOCK_MARKS);
});

/* ---------- Timetable ---------- */

const periodSchema = z.object({
  classKey: z.string().regex(/^cls-\d+[A-Z]$/),
  period: z.number().int().min(1).max(12),
  timeStart: z.string().regex(/^\d{2}:\d{2}$/),
  timeEnd: z.string().regex(/^\d{2}:\d{2}$/),
  subject: z.string().min(1).max(100),
  teacher: z.string().min(1).max(100),
  room: z.string().min(1).max(50),
});

/** GET /api/v1/admin/timetable — all class timetables */
router.get('/timetable', (req, res) => sendSuccess(res, MOCK_TIMETABLE));

/** POST /api/v1/admin/timetable — add a period */
router.post('/timetable', (req, res) => {
  const parsed = periodSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { classKey, ...period } = parsed.data;
  if (!MOCK_TIMETABLE[classKey]) MOCK_TIMETABLE[classKey] = [];
  MOCK_TIMETABLE[classKey].push(period);
  MOCK_TIMETABLE[classKey].sort((a, b) => a.period - b.period);
  return sendSuccess(res, period, 'Period added', 201);
});

/** DELETE /api/v1/admin/timetable/:classKey/:period */
router.delete('/timetable/:classKey/:period', (req, res) => {
  const { classKey, period } = req.params;
  const list = MOCK_TIMETABLE[classKey] || [];
  const idx = list.findIndex((p) => String(p.period) === period);
  if (idx === -1) return sendError(res, 'Period not found', 404, 'NOT_FOUND');
  list.splice(idx, 1);
  return sendSuccess(res, { classKey, period }, 'Period deleted');
});

/* ---------- Syllabus ---------- */

const syllabusSchema = z.object({
  classKey: z.string().regex(/^cls-\d+[A-Z]$/),
  subject: z.string().min(1).max(100),
  topics: z.array(z.string().min(1)).min(1),
  completedPercent: z.number().min(0).max(100),
});

/** GET /api/v1/admin/syllabus — all class syllabus records */
router.get('/syllabus', (req, res) => sendSuccess(res, MOCK_SYLLABUS));

/** POST /api/v1/admin/syllabus */
router.post('/syllabus', (req, res) => {
  const parsed = syllabusSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { classKey, ...entry } = parsed.data;
  if (!MOCK_SYLLABUS[classKey]) MOCK_SYLLABUS[classKey] = [];
  const existing = MOCK_SYLLABUS[classKey].findIndex((s) => s.subject === entry.subject);
  if (existing !== -1) {
    MOCK_SYLLABUS[classKey][existing] = entry;
    return sendSuccess(res, entry, 'Syllabus updated');
  }
  MOCK_SYLLABUS[classKey].push(entry);
  return sendSuccess(res, entry, 'Syllabus uploaded', 201);
});

/* ---------- Achievements ---------- */

const achievementSchema = z.object({
  studentId: z.string().min(1),
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(500),
  date: dateStr,
  type: z.enum(['academic', 'sports', 'cultural', 'other']),
});

/** GET /api/v1/admin/achievements — flattened list with student names */
router.get('/achievements', (req, res) => {
  const list = [];
  Object.entries(MOCK_ACHIEVEMENTS).forEach(([studentId, items]) => {
    const student = MOCK_STUDENTS.find((s) => s.id === studentId);
    items.forEach((a) => list.push({ ...a, studentId, studentName: student?.name || studentId }));
  });
  list.sort((a, b) => (a.date < b.date ? 1 : -1));
  return sendSuccess(res, list);
});

/** POST /api/v1/admin/achievements */
router.post('/achievements', (req, res) => {
  const parsed = achievementSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { studentId, ...rest } = parsed.data;
  const student = MOCK_STUDENTS.find((s) => s.id === studentId);
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const newAchievement = { id: newId('ach'), ...rest };
  if (!MOCK_ACHIEVEMENTS[studentId]) MOCK_ACHIEVEMENTS[studentId] = [];
  MOCK_ACHIEVEMENTS[studentId].push(newAchievement);
  return sendSuccess(res, newAchievement, 'Achievement added', 201);
});

/** DELETE /api/v1/admin/achievements/:id */
router.delete('/achievements/:id', (req, res) => {
  let removed = null;
  Object.keys(MOCK_ACHIEVEMENTS).forEach((studentId) => {
    const idx = MOCK_ACHIEVEMENTS[studentId].findIndex((a) => a.id === req.params.id);
    if (idx !== -1) removed = MOCK_ACHIEVEMENTS[studentId].splice(idx, 1)[0];
  });
  if (!removed) return sendError(res, 'Achievement not found', 404, 'NOT_FOUND');
  return sendSuccess(res, { id: removed.id }, 'Achievement deleted');
});

/* ---------- Documents ---------- */

const documentSchema = z.object({
  type: z.string().min(2).max(100),
  fileName: z.string().min(2).max(200),
});

/** POST /api/v1/admin/employees/:id/documents — upload document record */
router.post('/employees/:id/documents', (req, res) => {
  const parsed = documentSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const employee = MOCK_EMPLOYEES.find((e) => e.id === req.params.id);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  const newDoc = { id: newId('doc'), uploadedAt: new Date().toISOString(), ...parsed.data };
  if (!MOCK_DOCUMENTS[employee.id]) MOCK_DOCUMENTS[employee.id] = [];
  MOCK_DOCUMENTS[employee.id].unshift(newDoc);
  return sendSuccess(res, newDoc, 'Document uploaded', 201);
});

/** GET /api/v1/admin/documents — flattened list with employee names */
router.get('/documents', (req, res) => {
  const list = [];
  Object.entries(MOCK_DOCUMENTS).forEach(([employeeId, items]) => {
    const employee = MOCK_EMPLOYEES.find((e) => e.id === employeeId);
    items.forEach((d) => list.push({ ...d, employeeId, employeeName: employee?.name || employeeId }));
  });
  list.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  return sendSuccess(res, list);
});

/** DELETE /api/v1/admin/documents/:id — remove a document record */
router.delete('/documents/:id', (req, res) => {
  let removed = null;
  Object.keys(MOCK_DOCUMENTS).forEach((employeeId) => {
    const idx = MOCK_DOCUMENTS[employeeId].findIndex((d) => d.id === req.params.id);
    if (idx !== -1) removed = MOCK_DOCUMENTS[employeeId].splice(idx, 1)[0];
  });
  if (!removed) return sendError(res, 'Document not found', 404, 'NOT_FOUND');
  return sendSuccess(res, { id: removed.id }, 'Document deleted');
});

/* ---------- Users / Password reset ---------- */

/** GET /api/v1/admin/users — sanitized user list (never includes password hashes) */
router.get('/users', (req, res) => {
  const users = MOCK_USERS.map(({ passwordHash, ...safe }) => safe);
  return sendSuccess(res, users);
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

/** PUT /api/v1/admin/users/:id/reset-password */
router.put('/users/:id/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const user = MOCK_USERS.find((u) => u.id === req.params.id);
  if (!user) return sendError(res, 'User not found', 404, 'NOT_FOUND');

  user.passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  return sendSuccess(res, null, 'Password reset successfully');
});

/* ---------- Reports ---------- */

/** GET /api/v1/admin/reports/summary — key stats for the admin dashboard */
router.get('/reports/summary', (req, res) => {
  const pendingLeaves = Object.values(MOCK_LEAVES)
    .reduce((sum, data) => sum + data.history.filter((l) => l.status === 'pending').length, 0);

  return sendSuccess(res, {
    totalStudents: MOCK_STUDENTS.length,
    totalEmployees: MOCK_EMPLOYEES.length,
    totalFeeDues: MOCK_STUDENTS.reduce((s, x) => s + (x.feeDues || 0), 0),
    totalAnnouncements: MOCK_ANNOUNCEMENTS.length,
    totalHolidays: MOCK_HOLIDAYS.length,
    pendingLeaves,
  });
});

module.exports = router;
