/**
 * Mock student data.
 * In production, replace service calls with Supabase queries.
 */
const MOCK_STUDENTS = [
  {
    id: 'stu-001',
    userId: 'usr-002',
    name: 'Arjun Kumar',
    photo: null,
    class: '10',
    section: 'A',
    admissionYear: 2022,
    rollNumber: 'STU-2022-001',
    feeTotal: 45000,
    feeDues: 5000,
    parentName: 'Rajesh Kumar',
    guardianContact: '+91-9876543210',
    address: '42, MG Road, Bangalore - 560001',
    bloodGroup: 'O+',
    dob: '2010-05-14',
  },
  {
    id: 'stu-002',
    userId: null,
    name: 'Sneha Reddy',
    photo: null,
    class: '10',
    section: 'A',
    admissionYear: 2022,
    rollNumber: 'STU-2022-002',
    feeTotal: 45000,
    feeDues: 0,
    parentName: 'Suresh Reddy',
    guardianContact: '+91-9876512345',
    address: '15, JP Nagar, Bangalore - 560078',
    bloodGroup: 'A+',
    dob: '2010-08-22',
  },
  {
    id: 'stu-003',
    userId: null,
    name: 'Rahul Menon',
    photo: null,
    class: '9',
    section: 'B',
    admissionYear: 2023,
    rollNumber: 'STU-2023-001',
    feeTotal: 40000,
    feeDues: 10000,
    parentName: 'Anand Menon',
    guardianContact: '+91-9845678901',
    address: '8, Koramangala, Bangalore - 560034',
    bloodGroup: 'B+',
    dob: '2011-03-10',
  },
];

const MOCK_ATTENDANCE_STUDENT = {
  'stu-001': {
    '2026-09': {
      '2026-09-01': 'present',
      '2026-09-02': 'present',
      '2026-09-03': 'absent',
      '2026-09-04': 'present',
      '2026-09-05': 'holiday',
      '2026-09-06': 'holiday',
      '2026-09-08': 'present',
      '2026-09-09': 'present',
      '2026-09-10': 'present',
    },
  },
};

const MOCK_MARKS = {
  'stu-001': [
    {
      examId: 'exam-001',
      examName: 'Unit Test 1',
      date: '2026-08-15',
      subjects: [
        { subject: 'Mathematics', maxMarks: 100, obtained: 87 },
        { subject: 'Science', maxMarks: 100, obtained: 92 },
        { subject: 'English', maxMarks: 100, obtained: 78 },
        { subject: 'Hindi', maxMarks: 100, obtained: 85 },
        { subject: 'Social Studies', maxMarks: 100, obtained: 80 },
      ],
    },
    {
      examId: 'exam-002',
      examName: 'Mid Term',
      date: '2026-09-05',
      subjects: [
        { subject: 'Mathematics', maxMarks: 100, obtained: 91 },
        { subject: 'Science', maxMarks: 100, obtained: 88 },
        { subject: 'English', maxMarks: 100, obtained: 82 },
        { subject: 'Hindi', maxMarks: 100, obtained: 79 },
        { subject: 'Social Studies', maxMarks: 100, obtained: 84 },
      ],
    },
  ],
};

const MOCK_ACHIEVEMENTS = {
  'stu-001': [
    {
      id: 'ach-001',
      title: 'Science Olympiad — District Winner',
      description: 'Secured 1st place in the district-level Science Olympiad 2026.',
      date: '2026-07-20',
      type: 'academic',
    },
    {
      id: 'ach-002',
      title: 'Best Athlete Award',
      description: 'Awarded for outstanding performance in the Annual Sports Meet.',
      date: '2026-02-10',
      type: 'sports',
    },
  ],
};

/** Per-student document records (metadata only — real file storage is future work) */
const MOCK_STUDENT_DOCUMENTS = {
  'stu-001': [
    { id: 'sdoc-001', type: 'Birth Certificate', fileName: 'birth_certificate.pdf', uploadedAt: '2022-06-01T00:00:00Z' },
    { id: 'sdoc-002', type: 'Transfer Certificate', fileName: 'tc_previous_school.pdf', uploadedAt: '2022-06-05T00:00:00Z' },
  ],
  // stu-002 deliberately has none — the empty state must show for real.
};

module.exports = {
  MOCK_STUDENTS,
  MOCK_ATTENDANCE_STUDENT,
  MOCK_MARKS,
  MOCK_ACHIEVEMENTS,
  MOCK_STUDENT_DOCUMENTS,
};
