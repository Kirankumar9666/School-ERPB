const bcrypt = require('bcrypt');
const { ROLES } = require('../constants/roles');

/**
 * Mock user store.
 * Passwords are pre-hashed (bcrypt, 10 rounds).
 * In production, replace with Supabase query.
 *
 * Default credentials:
 *   admin   / Admin@123
 *   student / Student@123
 *   teacher / Teacher@123
 */
const MOCK_USERS = [
  {
    id: 'usr-001',
    username: 'admin',
    // bcrypt hash of "Admin@123"
    passwordHash: bcrypt.hashSync('Admin@123', 10),
    role: ROLES.ADMIN,
    name: 'Admin User',
    profilePhoto: null,
    status: 'active',
  },
  {
    id: 'usr-002',
    username: 'student',
    passwordHash: bcrypt.hashSync('Student@123', 10),
    role: ROLES.STUDENT,
    name: 'Arjun Kumar',
    profilePhoto: null,
    linkedEntityId: 'stu-001', // links to student record
    status: 'active',
  },
  {
    id: 'usr-003',
    username: 'teacher',
    passwordHash: bcrypt.hashSync('Teacher@123', 10),
    role: ROLES.TEACHER,
    name: 'Priya Sharma',
    profilePhoto: null,
    linkedEntityId: 'emp-001', // links to employee record
    status: 'active',
  },
  {
    id: 'usr-004',
    username: 'accountant',
    passwordHash: bcrypt.hashSync('Accounts@123', 10),
    role: ROLES.ACCOUNTANT,
    name: 'Ravi Patel',
    profilePhoto: null,
    linkedEntityId: 'emp-002',
    status: 'active',
  },
];

module.exports = { MOCK_USERS };
