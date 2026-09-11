/**
 * Mock employee data — teachers, accountants, librarians.
 */
const { ROLES } = require('../constants/roles');

const MOCK_EMPLOYEES = [
  {
    id: 'emp-001',
    userId: 'usr-003',
    name: 'Priya Sharma',
    photo: null,
    employeeId: 'EMP-2020-001',
    gender: 'Female',
    dob: '1990-03-15',
    bloodGroup: 'B+',
    mobile: '+91-9876500001',
    email: 'priya.sharma@schoolerp.in',
    address: '12, Indiranagar, Bangalore - 560038',
    emergencyContact: '+91-9876500002',
    department: 'Mathematics',
    designation: 'Senior Teacher',
    role: ROLES.TEACHER,
    qualification: 'M.Sc Mathematics, B.Ed',
    dateOfJoining: '2020-06-01',
    experience: '6 years',
    reportingPrincipal: 'Dr. Mahesh Rao',
    employmentType: 'Permanent',
    status: 'active',
    assignedClasses: [
      { classId: 'cls-10A', class: '10', section: 'A', subject: 'Mathematics', studentCount: 38, room: '101', isClassTeacher: true },
      { classId: 'cls-9B', class: '9', section: 'B', subject: 'Mathematics', studentCount: 35, room: '201', isClassTeacher: false },
    ],
  },
  {
    id: 'emp-002',
    userId: 'usr-004',
    name: 'Ravi Patel',
    photo: null,
    employeeId: 'EMP-2019-002',
    gender: 'Male',
    dob: '1985-07-22',
    bloodGroup: 'O+',
    mobile: '+91-9876500003',
    email: 'ravi.patel@schoolerp.in',
    address: '5, HSR Layout, Bangalore - 560102',
    emergencyContact: '+91-9876500004',
    department: 'Accounts',
    designation: 'Accountant',
    role: ROLES.ACCOUNTANT,
    qualification: 'B.Com, CA (Inter)',
    dateOfJoining: '2019-04-01',
    experience: '7 years',
    reportingPrincipal: 'Dr. Mahesh Rao',
    employmentType: 'Permanent',
    status: 'active',
    assignedClasses: [],
  },
];

const MOCK_ATTENDANCE_EMPLOYEE = {
  'emp-001': {
    '2026-09': {
      '2026-09-01': { status: 'present', workingHours: 8 },
      '2026-09-02': { status: 'present', workingHours: 8 },
      '2026-09-03': { status: 'late', workingHours: 7 },
      '2026-09-04': { status: 'present', workingHours: 8 },
      '2026-09-05': { status: 'holiday', workingHours: 0 },
      '2026-09-06': { status: 'holiday', workingHours: 0 },
      '2026-09-08': { status: 'present', workingHours: 8 },
      '2026-09-09': { status: 'absent', workingHours: 0 },
      '2026-09-10': { status: 'present', workingHours: 8 },
    },
  },
};

const MOCK_LEAVES = {
  'emp-001': {
    balance: { casual: 8, sick: 4, earned: 15 },
    history: [
      { id: 'lv-001', type: 'sick', fromDate: '2026-09-09', toDate: '2026-09-09', reason: 'Fever', status: 'approved', appliedAt: '2026-09-08T18:00:00Z' },
      { id: 'lv-002', type: 'casual', fromDate: '2026-10-03', toDate: '2026-10-04', reason: 'Family function', status: 'pending', appliedAt: '2026-09-10T09:00:00Z' },
    ],
  },
};

const MOCK_PAYROLL = {
  'emp-001': [
    {
      month: '2026-08',
      monthLabel: 'August 2026',
      basicPay: 45000,
      allowances: { hra: 9000, transportAllowance: 2000, medicalAllowance: 1250 },
      deductions: { providentFund: 5400, professionalTax: 200, tds: 3000 },
      netSalary: 48650,
      paidOn: '2026-08-31',
    },
    {
      month: '2026-09',
      monthLabel: 'September 2026',
      basicPay: 45000,
      allowances: { hra: 9000, transportAllowance: 2000, medicalAllowance: 1250 },
      deductions: { providentFund: 5400, professionalTax: 200, tds: 3000 },
      netSalary: 48650,
      paidOn: null, // not paid yet
    },
  ],
};

const MOCK_DOCUMENTS = {
  'emp-001': [
    { id: 'doc-001', type: 'Appointment Letter', fileName: 'appointment_letter.pdf', uploadedAt: '2020-06-01T00:00:00Z' },
    { id: 'doc-002', type: 'Employee ID Card', fileName: 'id_card.pdf', uploadedAt: '2020-06-05T00:00:00Z' },
    { id: 'doc-003', type: 'Salary Slip — Aug 2026', fileName: 'salary_slip_aug_2026.pdf', uploadedAt: '2026-08-31T00:00:00Z' },
    { id: 'doc-004', type: 'Educational Certificate', fileName: 'msc_certificate.pdf', uploadedAt: '2020-06-01T00:00:00Z' },
  ],
};

module.exports = {
  MOCK_EMPLOYEES,
  MOCK_ATTENDANCE_EMPLOYEE,
  MOCK_LEAVES,
  MOCK_PAYROLL,
  MOCK_DOCUMENTS,
};
