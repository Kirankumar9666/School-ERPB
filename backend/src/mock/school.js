/**
 * Mock school-level data: timetable, holidays, announcements, syllabus.
 */

const MOCK_TIMETABLE = {
  'cls-10A': [
    { period: 1, timeStart: '08:00', timeEnd: '08:45', subject: 'Mathematics', teacher: 'Priya Sharma', room: '101' },
    { period: 2, timeStart: '08:45', timeEnd: '09:30', subject: 'Science', teacher: 'Dr. Ajay Nair', room: '102' },
    { period: 3, timeStart: '09:30', timeEnd: '10:15', subject: 'English', teacher: 'Mrs. Kavitha', room: '103' },
    { period: 4, timeStart: '10:30', timeEnd: '11:15', subject: 'Hindi', teacher: 'Mr. Suresh', room: '104' },
    { period: 5, timeStart: '11:15', timeEnd: '12:00', subject: 'Social Studies', teacher: 'Mrs. Lakshmi', room: '105' },
    { period: 6, timeStart: '13:00', timeEnd: '13:45', subject: 'Computer Science', teacher: 'Mr. Vikram', room: 'Lab-1' },
    { period: 7, timeStart: '13:45', timeEnd: '14:30', subject: 'Physical Education', teacher: 'Mr. Rajan', room: 'Ground' },
  ],
};

const MOCK_HOLIDAYS = [
  { id: 'hol-001', date: '2026-09-05', name: 'Teachers Day' },
  { id: 'hol-002', date: '2026-10-02', name: 'Gandhi Jayanti' },
  { id: 'hol-003', date: '2026-10-24', name: 'Diwali' },
  { id: 'hol-004', date: '2026-11-01', name: 'Kannada Rajyotsava' },
  { id: 'hol-005', date: '2026-12-25', name: 'Christmas' },
  { id: 'hol-006', date: '2027-01-01', name: 'New Year' },
  { id: 'hol-007', date: '2027-01-26', name: 'Republic Day' },
];

/**
 * Each announcement carries its visibility window (showFrom ≤ today ≤
 * showUntil, both inclusive) — the portals hide anything outside it. The
 * windows below are fixture values aligned with the notice content and kept
 * open past their event dates (e.g. the staff meeting stays listed after the
 * 12th) so the demo data and the role-filtering tests stay deterministic
 * around the seed timeline.
 */
const MOCK_ANNOUNCEMENTS = [
  {
    id: 'ann-001',
    title: 'Annual Sports Day — 15th October 2026',
    body: 'The Annual Sports Day will be held on 15th October 2026 at the school ground. All students must report by 8:00 AM. Parents are cordially invited. Please note that regular classes will be suspended for the day.',
    targetRoles: ['student', 'teacher', 'parent'],
    createdAt: '2026-09-08T10:00:00Z',
    category: 'event',
    showFrom: '2026-09-08',
    showUntil: '2026-10-16',
  },
  {
    id: 'ann-002',
    title: 'Staff Meeting — 12th September 2026',
    body: 'A mandatory staff meeting has been scheduled for 12th September 2026 at 4:00 PM in the conference room. All teaching and non-teaching staff must attend.',
    targetRoles: ['teacher', 'accountant', 'librarian'],
    createdAt: '2026-09-07T09:00:00Z',
    category: 'meeting',
    showFrom: '2026-09-07',
    showUntil: '2026-09-30',
  },
  {
    id: 'ann-003',
    title: 'Mid-Term Examination Schedule',
    body: 'Mid-term examinations for Classes 6–10 will be held from 20th September to 25th September 2026. Detailed timetable will be shared by the class teachers. Students must bring their school ID and stationery.',
    targetRoles: ['student', 'teacher', 'parent'],
    createdAt: '2026-09-05T08:00:00Z',
    category: 'exam',
    showFrom: '2026-09-05',
    showUntil: '2026-09-26',
  },
  {
    id: 'ann-004',
    title: 'School Closed — Diwali Vacation',
    body: 'The school will remain closed from 22nd October to 27th October 2026 for Diwali vacation. School will reopen on 28th October 2026. Wishing everyone a Happy Diwali!',
    targetRoles: ['student', 'teacher', 'accountant', 'librarian', 'parent'],
    createdAt: '2026-09-01T08:00:00Z',
    category: 'holiday',
    showFrom: '2026-09-01',
    showUntil: '2026-10-28',
  },
];

const MOCK_SYLLABUS = {
  'cls-10A': [
    { subject: 'Mathematics', topics: ['Algebra', 'Geometry', 'Trigonometry', 'Statistics', 'Probability'], completedPercent: 60 },
    { subject: 'Science', topics: ['Chemical Reactions', 'Life Processes', 'Electricity', 'Magnetic Effects', 'Light'], completedPercent: 55 },
    { subject: 'English', topics: ['First Flight', 'Footprints without Feet', 'Grammar', 'Writing Skills'], completedPercent: 70 },
    { subject: 'Social Studies', topics: ['India and the Contemporary World', 'Contemporary India', 'Democratic Politics', 'Economics'], completedPercent: 50 },
  ],
};

module.exports = {
  MOCK_TIMETABLE,
  MOCK_HOLIDAYS,
  MOCK_ANNOUNCEMENTS,
  MOCK_SYLLABUS,
};
