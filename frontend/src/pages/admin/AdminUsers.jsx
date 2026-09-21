import { useEffect, useState } from 'react';
import { KeyRound, Users } from 'lucide-react';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import ClassSelect from '../../components/ClassSelect';
import ResetPasswordModal from '../../components/ResetPasswordModal';

/** '10' + 'A' → 'cls-10A' (same id format the class list uses) */
const classIdOf = (grade, section) => `cls-${String(grade)}${String(section).toUpperCase()}`;

/** Column headers shared by every account table on this page */
const ACCOUNT_HEADERS = (
  <thead>
    <tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>{''}</th></tr>
  </thead>
);

/**
 * One account row — same columns and badge styling the flat "All Users" table
 * used, so the restructure is a navigation change only.
 */
function AccountRow({ user, onReset }) {
  return (
    <tr>
      <td><b>{user.name}</b></td>
      <td>{user.username}</td>
      <td><span className="badge badge-info">{user.role}</span></td>
      <td>
        <span className={`badge ${user.status === 'active' ? 'badge-success' : 'badge-muted'}`}>{user.status}</span>
      </td>
      <td>
        <button className="btn btn-secondary btn-sm" onClick={() => onReset(user)}>
          <KeyRound size={14} /> Reset Password
        </button>
      </td>
    </tr>
  );
}

/**
 * Admin Users — account lookup behind Students / Employees top-level tabs
 * (same pattern as Attendance and Document Management), with any account not
 * tied to a student or employee record (e.g. the admin) kept in a separate
 * "Other Accounts" section below so nothing is lost in the restructure.
 *
 * Accounts come live from GET /admin/users (sanitized — never password
 * hashes) and are matched to the selected person via `linkedEntityId`.
 * Password resets use the same PUT /admin/users/:id/reset-password flow as
 * before — this page is a layout/navigation change only.
 */
export default function AdminUsers() {
  const [tab, setTab] = useState('students');
  const [users, setUsers] = useState([]);
  const [classes, setClasses] = useState([]);
  const [students, setStudents] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Students tab selection
  const [classKey, setClassKey] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [studentQuery, setStudentQuery] = useState(''); // name/roll-no search within the class
  // Employees tab selection
  const [employeeQuery, setEmployeeQuery] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');

  // Reset-password modal (shared ResetPasswordModal component)
  const [resetting, setResetting] = useState(null); // user being reset

  useEffect(() => {
    Promise.all([
      api.get('/admin/users'),
      api.get('/admin/students'),
      api.get('/admin/employees'),
      loadOptions(),
    ])
      .then(([u, s, e, o]) => {
        setUsers(u.data.data || []);
        setStudents(s.data.data || []);
        setEmployees(e.data.data || []);
        setClasses(o.classes);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [reloadKey]);

  /** Roster of the selected class, narrowed live by the name/roll-no search */
  const roster = students.filter((s) => classIdOf(s.class, s.section) === classKey);
  const studentTerm = studentQuery.trim().toLowerCase();
  const classStudents = roster.filter((s) => !studentTerm
    || [s.name, s.rollNumber].some((v) => String(v ?? '').toLowerCase().includes(studentTerm)));
  const selectedStudent = students.find((s) => s.id === selectedStudentId) || null;
  const selectedEmployee = employees.find((e) => e.id === selectedEmployeeId) || null;

  /** Live name/role search for the Employees tab */
  const employeeTerm = employeeQuery.trim().toLowerCase();
  const employeeResults = employeeTerm
    ? employees.filter((e) => [e.name, e.role, e.designation]
      .some((v) => String(v ?? '').toLowerCase().includes(employeeTerm)))
    : employees;

  /** Account lookup: the sanitized user linked to the selected person (or null) */
  const studentAccount = selectedStudent
    ? users.find((u) => u.linkedEntityId === selectedStudent.id) || null
    : null;
  const employeeAccount = selectedEmployee
    ? users.find((u) => u.linkedEntityId === selectedEmployee.id) || null
    : null;

  /** Accounts not tied to any current student/employee record (e.g. the admin) */
  const studentIds = new Set(students.map((s) => s.id));
  const employeeIds = new Set(employees.map((e) => e.id));
  const otherAccounts = users.filter((u) => !u.linkedEntityId
    || (!studentIds.has(u.linkedEntityId) && !employeeIds.has(u.linkedEntityId)));

  const load = () => api.get('/admin/users').then((r) => setUsers(r.data.data));

  const openReset = (user) => {
    setResetting(user);
  };

  const clearSelection = () => {
    setSelectedStudentId('');
    setSelectedEmployeeId('');
  };

  const changeClass = (id) => {
    setClassKey(id);
    setSelectedStudentId('');
    setStudentQuery(''); // the search is class-scoped — a new class starts clean
  };

  const changeTab = (next) => {
    setTab(next);
    clearSelection();
    if (next === 'students') setStudentQuery('');
    else setEmployeeQuery('');
  };

  const selectStudent = (s) => setSelectedStudentId(s.id);

  const deselectStudent = () => setSelectedStudentId(''); // back to table/search results

  const selectEmployee = (e) => setSelectedEmployeeId(e.id);

  const deselectEmployee = () => setSelectedEmployeeId(''); // back to search results

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (loadError) {
    return (
      <div className="page fade-in">
        <div className="page-header">
          <div className="page-title">User Accounts</div>
          <div className="page-subtitle">Reset passwords from here</div>
        </div>
        <div className="empty-state">
          <Users size={40} />
          Could not load the account, class, student or employee lists. Check that the API is running.
          <button
            className="btn btn-primary btn-sm"
            style={{ marginTop: 'var(--sp-md)' }}
            onClick={() => { setLoadError(false); setLoading(true); setReloadKey((k) => k + 1); }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">User Accounts</div>
        <div className="page-subtitle">Student, employee and staff accounts • reset passwords from here</div>
      </div>

      {/* Top-level tabs — same pattern as Attendance / Document Management */}
      <div className="tabs">
        <button className={`tab-btn${tab === 'students' ? ' active' : ''}`} onClick={() => changeTab('students')}>Students</button>
        <button className={`tab-btn${tab === 'employees' ? ' active' : ''}`} onClick={() => changeTab('employees')}>Employees</button>
      </div>

      {tab === 'students' ? (
        <div className="card">
          <div style={{ display: 'flex', gap: 'var(--sp-md)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <ClassSelect
              id="users-class"
              placeholder="Choose a class…"
              value={classKey}
              onChange={changeClass}
              choices={classes}
              style={{ flex: 1, minWidth: 220, maxWidth: 320, marginBottom: 0 }}
            />
            <div className="form-group" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
              <label className="form-label" htmlFor="student-account-search">Search student</label>
              <input
                id="student-account-search"
                className="form-input"
                placeholder={classKey ? 'Search by name or roll no…' : 'Choose a class first…'}
                value={classKey ? studentQuery : ''}
                disabled={!classKey}
                onChange={(e) => setStudentQuery(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          {classKey && (
            selectedStudent ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--sp-md)',
                    flexWrap: 'wrap',
                    padding: 'var(--sp-md)',
                    border: '1px solid var(--line-2)',
                    borderRadius: 6,
                    background: 'var(--green-soft)',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{selectedStudent.name}</div>
                    <div className="text-sm text-muted">Roll No: {selectedStudent.rollNumber || '—'}</div>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={deselectStudent}>
                    Change student
                  </button>
                </div>
                {studentAccount ? (
                  <div className="table-wrapper">
                    <table>
                      {ACCOUNT_HEADERS}
                      <tbody>
                        <AccountRow user={studentAccount} onReset={openReset} />
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-state">
                    <Users size={32} />
                    No account set up for {selectedStudent.name}.
                  </div>
                )}
              </>
            ) : (
              <>
                {roster.length === 0 ? (
                  <div className="empty-state text-sm text-muted">
                    No students in this class yet — add students first.
                  </div>
                ) : classStudents.length === 0 ? (
                  <div className="empty-state text-sm text-muted">
                    No students match &ldquo;{studentQuery.trim()}&rdquo;.
                  </div>
                ) : (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr><th>Roll No</th><th>Name</th></tr>
                      </thead>
                      <tbody>
                        {classStudents.map((s) => (
                          <tr
                            key={s.id}
                            onClick={() => selectStudent(s)}
                            onKeyDown={(e) => { if (e.key === 'Enter') selectStudent(s); }}
                            tabIndex={0}
                            role="button"
                            style={{ cursor: 'pointer' }}
                          >
                            <td>{s.rollNumber || '—'}</td>
                            <td><b>{s.name}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )
          )}
        </div>
      ) : (
        <div className="card">
          <div className="form-group" style={{ marginBottom: 'var(--sp-md)' }}>
            <label className="form-label" htmlFor="employee-account-search">Search employee</label>
            <input
              id="employee-account-search"
              className="form-input"
              placeholder="Search employee by name…"
              value={employeeQuery}
              onChange={(e) => setEmployeeQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          {selectedEmployee ? (
            /* Collapsed: only the selected employee remains, with a way back */
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-md)', flexWrap: 'wrap', padding: 'var(--sp-md) 0 var(--sp-sm)' }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{selectedEmployee.name}</div>
                  <div className="text-sm text-muted">
                    {selectedEmployee.role || '—'}{selectedEmployee.designation ? ` · ${selectedEmployee.designation}` : ''}
                  </div>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={deselectEmployee}>
                  Change employee
                </button>
              </div>
              {employeeAccount ? (
                <div className="table-wrapper">
                  <table>
                    {ACCOUNT_HEADERS}
                    <tbody>
                      <AccountRow user={employeeAccount} onReset={openReset} />
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state">
                  <Users size={32} />
                  No account set up for {selectedEmployee.name}.
                </div>
              )}
            </>
          ) : employeeResults.length === 0 ? (
            <div className="empty-state text-sm text-muted">
              {employeeTerm ? `No employees match “${employeeQuery.trim()}”.` : 'No employees on staff yet.'}
            </div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr><th>Name</th><th>Role</th></tr>
                </thead>
                <tbody>
                  {employeeResults.map((e) => (
                    <tr
                      key={e.id}
                      onClick={() => selectEmployee(e)}
                      onKeyDown={(ev) => { if (ev.key === 'Enter') selectEmployee(e); }}
                      tabIndex={0}
                      role="button"
                      style={{ cursor: 'pointer' }}
                    >
                      <td><b>{e.name}</b></td>
                      <td>{e.role || '—'}{e.designation ? ` · ${e.designation}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Accounts not tied to a student/employee record (e.g. the admin) —
          kept here so no account type is lost in the restructure */}
      <div className="section">
        <div className="section-title"><Users size={14} /> Other Accounts</div>
        {otherAccounts.length === 0 ? (
          <div className="empty-state text-sm text-muted">
            No other accounts — every account is linked to a student or employee.
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              {ACCOUNT_HEADERS}
              <tbody>
                {otherAccounts.map((u) => <AccountRow key={u.id} user={u} onReset={openReset} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {resetting && (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onSuccess={load}
        />
      )}
    </div>
  );
}

