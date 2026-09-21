import { useEffect, useState } from 'react';
import { loadOptions, optionLabel } from '../../services/options';
import api from '../../services/api';
import MarkAttendance from '../../components/MarkAttendance';

/**
 * Admin Attendance — the admin's view of the school-wide "Mark Attendance"
 * flow. Top-level Students / Employees tabs pick the roster kind; the actual
 * flow (search → select → give/check, tap-to-toggle absences, one atomic
 * bulk confirm with the 1-hour edit window) lives in the shared
 * `MarkAttendance` component, which the employee portal renders too. The only
 * difference between the two callers is the group list and the API base the
 * server enforces permissions on.
 *
 * Groups are derived live: classes come from the options API (the real classes
 * table + headcounts), staff groups are the distinct designations of the live
 * employee list.
 */
export default function AdminAttendance() {
  const [tab, setTab] = useState('student'); // 'student' | 'employee'
  const [classes, setClasses] = useState([]); // live class list (options API)
  const [employees, setEmployees] = useState([]); // live employee list
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([api.get('/admin/employees'), loadOptions()])
      .then(([e, o]) => {
        if (!alive) return;
        setEmployees(e.data.data);
        setClasses(o.classes);
      })
      .catch(() => { if (alive) { setEmployees([]); setClasses([]); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  /* Live group list for the current tab — classes or designation groups. */
  const groups = tab === 'student'
    ? classes
    : Object.entries(
      employees.reduce((acc, emp) => {
        const key = emp.designation || 'Unassigned';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    ).map(([designation, count]) => ({ id: designation, label: optionLabel(designation), studentCount: count }));

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Mark Attendance</div>
        <div className="page-subtitle">Record daily attendance</div>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab-btn${tab === 'student' ? ' active' : ''}`}
          onClick={() => setTab('student')}
        >
          Students
        </button>
        <button
          type="button"
          className={`tab-btn${tab === 'employee' ? ' active' : ''}`}
          onClick={() => setTab('employee')}
        >
          Employees
        </button>
      </div>

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : (
        /* key={tab} remounts the flow on a tab switch → no roster from the
           other kind can linger. */
        <MarkAttendance
          key={tab}
          kind={tab}
          groups={groups}
          apiBase="/admin"
          nouns={{
            group: tab === 'student' ? 'class' : 'staff group',
            groups: tab === 'student' ? 'classes' : 'groups',
            members: tab === 'student' ? 'students' : 'members',
          }}
          searchPlaceholder={tab === 'student' ? 'Search class, e.g. 10 - A' : 'Search designation, e.g. Teacher'}
        />
      )}
    </div>
  );
}