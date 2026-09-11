import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ROLES, EMPLOYEE_ROLES } from './constants/roles'
import ProtectedLayout from './components/ProtectedLayout'

import './styles/components.css'
import './index.css'

import Login from './pages/Login'

// Student pages
import StudentHome from './pages/student/StudentHome'
import StudentProfile from './pages/student/StudentProfile'
import StudentAttendance from './pages/student/StudentAttendance'
import StudentMarks from './pages/student/StudentMarks'
import StudentTimetable from './pages/student/StudentTimetable'
import StudentSyllabus from './pages/student/StudentSyllabus'
import StudentCirculars from './pages/student/StudentCirculars'
import StudentHolidays from './pages/student/StudentHolidays'
import StudentAchievements from './pages/student/StudentAchievements'

// Employee pages
import EmployeeDashboard from './pages/employee/EmployeeDashboard'
import EmployeeProfile from './pages/employee/EmployeeProfile'
import EmployeeAttendance from './pages/employee/EmployeeAttendance'
import EmployeeLeave from './pages/employee/EmployeeLeave'
import EmployeePayroll from './pages/employee/EmployeePayroll'
import EmployeeTimetable from './pages/employee/EmployeeTimetable'
import EmployeeClasses from './pages/employee/EmployeeClasses'
import EmployeeAnnouncements from './pages/employee/EmployeeAnnouncements'
import EmployeeDocuments from './pages/employee/EmployeeDocuments'

// Admin pages
import AdminDashboard from './pages/admin/AdminDashboard'
import AdminStudents from './pages/admin/AdminStudents'
import AdminEmployees from './pages/admin/AdminEmployees'
import AdminAttendance from './pages/admin/AdminAttendance'
import AdminMarks from './pages/admin/AdminMarks'
import AdminTimetable from './pages/admin/AdminTimetable'
import AdminAnnouncements from './pages/admin/AdminAnnouncements'
import AdminHolidays from './pages/admin/AdminHolidays'
import AdminLeaves from './pages/admin/AdminLeaves'

/** Map role → home path (single source of truth) */
const ROLE_HOME = {
  [ROLES.ADMIN]: '/admin',
  [ROLES.STUDENT]: '/student',
  [ROLES.PARENT]: '/student',
  [ROLES.TEACHER]: '/employee',
  [ROLES.ACCOUNTANT]: '/employee',
  [ROLES.LIBRARIAN]: '/employee',
}

/** RootRedirect — sends users to their role home or to /login */
function RootRedirect() {
  const { user, isAuthenticated, loading } = useAuth()
  if (loading) {
    return (
      <div className="loading-center" style={{ minHeight: '100vh' }}>
        <div className="spinner" />
      </div>
    )
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <Navigate to={ROLE_HOME[user.role] || '/login'} replace />
}

/** App — top-level router wiring for the School ERP portal. */
export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RootRedirect />} />

          {/* Student portal */}
          <Route element={<ProtectedLayout allowedRoles={[ROLES.STUDENT, ROLES.PARENT]} navTitle="Student Portal" navSubtitle="Welcome back" />}>
            <Route path="/student" element={<StudentHome />} />
            <Route path="/student/profile" element={<StudentProfile />} />
            <Route path="/student/attendance" element={<StudentAttendance />} />
            <Route path="/student/marks" element={<StudentMarks />} />
            <Route path="/student/timetable" element={<StudentTimetable />} />
            <Route path="/student/syllabus" element={<StudentSyllabus />} />
            <Route path="/student/circulars" element={<StudentCirculars />} />
            <Route path="/student/holidays" element={<StudentHolidays />} />
            <Route path="/student/achievements" element={<StudentAchievements />} />
          </Route>

          {/* Employee portal */}
          <Route element={<ProtectedLayout allowedRoles={EMPLOYEE_ROLES} navTitle="Employee Portal" navSubtitle="Welcome back" />}>
            <Route path="/employee" element={<EmployeeDashboard />} />
            <Route path="/employee/profile" element={<EmployeeProfile />} />
            <Route path="/employee/attendance" element={<EmployeeAttendance />} />
            <Route path="/employee/leave" element={<EmployeeLeave />} />
            <Route path="/employee/payroll" element={<EmployeePayroll />} />
            <Route path="/employee/timetable" element={<EmployeeTimetable />} />
            <Route path="/employee/classes" element={<EmployeeClasses />} />
            <Route path="/employee/announcements" element={<EmployeeAnnouncements />} />
            <Route path="/employee/documents" element={<EmployeeDocuments />} />
          </Route>

          {/* Admin panel */}
          <Route element={<ProtectedLayout allowedRoles={[ROLES.ADMIN]} navTitle="Admin Panel" navSubtitle="Management console" />}>
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/admin/students" element={<AdminStudents />} />
            <Route path="/admin/employees" element={<AdminEmployees />} />
            <Route path="/admin/attendance" element={<AdminAttendance />} />
            <Route path="/admin/marks" element={<AdminMarks />} />
            <Route path="/admin/timetable" element={<AdminTimetable />} />
            <Route path="/admin/announcements" element={<AdminAnnouncements />} />
            <Route path="/admin/holidays" element={<AdminHolidays />} />
            <Route path="/admin/leaves" element={<AdminLeaves />} />
          </Route>

          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}