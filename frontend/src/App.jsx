import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { Toaster } from 'react-hot-toast'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ROLES, EMPLOYEE_ROLES } from './constants/roles'
import ProtectedLayout from './components/ProtectedLayout'

import './styles/components.css'
import './index.css'

// Login + the shared layout stay in the initial bundle (first paint + shell);
// every role page is code-split so a user only downloads the portal they use
// (student / employee / admin) instead of all 27 screens up front.
const Login = lazy(() => import('./pages/Login'))

// Student pages
const StudentHome = lazy(() => import('./pages/student/StudentHome'))
const StudentProfile = lazy(() => import('./pages/student/StudentProfile'))
const StudentAttendance = lazy(() => import('./pages/student/StudentAttendance'))
const StudentMarks = lazy(() => import('./pages/student/StudentMarks'))
const StudentTimetable = lazy(() => import('./pages/student/StudentTimetable'))
const StudentSyllabus = lazy(() => import('./pages/student/StudentSyllabus'))
const StudentCirculars = lazy(() => import('./pages/student/StudentCirculars'))
const StudentHolidays = lazy(() => import('./pages/student/StudentHolidays'))
const StudentAchievements = lazy(() => import('./pages/student/StudentAchievements'))

// Employee pages
const EmployeeDashboard = lazy(() => import('./pages/employee/EmployeeDashboard'))
const EmployeeProfile = lazy(() => import('./pages/employee/EmployeeProfile'))
const EmployeeAttendance = lazy(() => import('./pages/employee/EmployeeAttendance'))
const EmployeeLeave = lazy(() => import('./pages/employee/EmployeeLeave'))
const EmployeePayroll = lazy(() => import('./pages/employee/EmployeePayroll'))
const EmployeeTimetable = lazy(() => import('./pages/employee/EmployeeTimetable'))
const EmployeeClasses = lazy(() => import('./pages/employee/EmployeeClasses'))
const EmployeeAnnouncements = lazy(() => import('./pages/employee/EmployeeAnnouncements'))
const EmployeeDocuments = lazy(() => import('./pages/employee/EmployeeDocuments'))

// Admin pages
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'))
const AdminStudents = lazy(() => import('./pages/admin/AdminStudents'))
const AdminEmployees = lazy(() => import('./pages/admin/AdminEmployees'))
const AdminAttendance = lazy(() => import('./pages/admin/AdminAttendance'))
const AdminMarks = lazy(() => import('./pages/admin/AdminMarks'))
const AdminTimetable = lazy(() => import('./pages/admin/AdminTimetable'))
const AdminAnnouncements = lazy(() => import('./pages/admin/AdminAnnouncements'))
const AdminHolidays = lazy(() => import('./pages/admin/AdminHolidays'))
const AdminCalendar = lazy(() => import('./pages/admin/AdminCalendar'))
const AdminLeaves = lazy(() => import('./pages/admin/AdminLeaves'))
const AdminSyllabus = lazy(() => import('./pages/admin/AdminSyllabus'))
const AdminAchievements = lazy(() => import('./pages/admin/AdminAchievements'))
const AdminDocuments = lazy(() => import('./pages/admin/AdminDocuments'))
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers'))
const AdminPayroll = lazy(() => import('./pages/admin/AdminPayroll'))

/** Map role → home path (single source of truth) */
const ROLE_HOME = {
  [ROLES.ADMIN]: '/admin',
  [ROLES.STUDENT]: '/student',
  [ROLES.PARENT]: '/student',
  [ROLES.TEACHER]: '/employee',
  [ROLES.ACCOUNTANT]: '/employee',
  [ROLES.LIBRARIAN]: '/employee',
}

/** Full-viewport spinner — shared by the auth gate and Suspense page loads */
function PageLoader() {
  return (
    <div className="loading-center" style={{ minHeight: '100vh' }}>
      <div className="spinner" />
    </div>
  )
}

/** RootRedirect — sends users to their role home or to /login */
function RootRedirect() {
  const { user, isAuthenticated, loading } = useAuth()
  if (loading) return <PageLoader />
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <Navigate to={ROLE_HOME[user.role] || '/login'} replace />
}

/** App — top-level router wiring for the School ERP portal. */
export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        {/* Every lazy page chunk resolves behind this spinner (same UI the
            auth gate shows) — no layout change, no flash of empty content. */}
        <Suspense fallback={<PageLoader />}>
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
            <Route path="/admin/payroll" element={<AdminPayroll />} />
            <Route path="/admin/attendance" element={<AdminAttendance />} />
            <Route path="/admin/marks" element={<AdminMarks />} />
            <Route path="/admin/timetable" element={<AdminTimetable />} />
            <Route path="/admin/announcements" element={<AdminAnnouncements />} />
            <Route path="/admin/holidays" element={<AdminHolidays />} />
            <Route path="/admin/calendar" element={<AdminCalendar />} />
            <Route path="/admin/leaves" element={<AdminLeaves />} />
            <Route path="/admin/syllabus" element={<AdminSyllabus />} />
            <Route path="/admin/achievements" element={<AdminAchievements />} />
            <Route path="/admin/documents" element={<AdminDocuments />} />
            <Route path="/admin/users" element={<AdminUsers />} />
          </Route>

          <Route path="*" element={<RootRedirect />} />
          </Routes>
        </Suspense>
        {/* Toasts are fired from many pages (upload success/failure, deletes,
            form validation). Without this single mount react-hot-toast renders
            nothing, so successful actions looked like the button did nothing. */}
        <Toaster position="top-right" toastOptions={{ duration: 4000 }} />
      </BrowserRouter>
    </AuthProvider>
  )
}