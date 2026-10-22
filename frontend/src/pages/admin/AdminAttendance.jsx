import { useEffect, useState } from 'react';
import { loadOptions } from '../../services/options';
import api from '../../services/api';
import MarkAttendance from '../../components/MarkAttendance';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';

/**
 * Admin Attendance — the admin's view of the school-wide "Mark Attendance"
 * flow. Top-level Students / Employees tabs pick the roster kind; the actual
 * flow (search → select → give/check, tap-to-toggle absences, one atomic
 * bulk confirm with the 1-hour edit window) lives in the shared
 * `MarkAttendance` component, which the employee portal renders too. The only
 * difference between the two callers is the list the caller has scoped
 * (`groups`) and the API base the server enforces permissions on.
 *
 * Both lists are derived live, never hardcoded: classes come from the options
 * API (the real classes table + headcounts), employees from `/admin/employees`.
 *
 * Students are marked a class at a time — a class really is the unit of
 * attendance. Employees are marked a PERSON at a time: the search lists every
 * employee flat, each row carrying their designation and department, and
 * picking one opens that person's own record (and their own edit window). The
 * old designation-grouped list forced a pointless drill-down through
 * "Senior Teacher — 1 members" before you could reach a name, and grouped
 * several colleagues' attendance under one confirmation. This matches the
 * search → flat list → pick-a-person flow already used by Document Management
 * and User Accounts.
 */
export default function AdminAttendance() {
  const [tab, setTab] = useState('student'); // 'student' | 'employee'
  const [classes, setClasses] = useState([]); // live class list (options API)
  const [employees, setEmployees] = useState([]); // live employee list
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();

  useEffect(() => {
    let alive = true;
    Promise.all([api.get('/admin/employees'), loadOptions()])
      .then(([e, o]) => {
        if (!alive) return;
        setEmployees(e.data.data);
        setClasses(o.classes);
      })
      // Recorded rather than folded into the empty lists. An empty `groups`
      // array is rendered below as "No classes to show" — saying that when the
      // request actually failed claims the school has no classes, which is a
      // different thing entirely from not having been told.
      .catch((err) => { if (alive) fail(err); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reloadKey, fail, setLoading]);

  /* Live list for the current tab — a flat, per-person employee list (with the
     designation/department each search row shows) or the real class list. */
  const groups = tab === 'student'
    ? classes
    : employees.map((e) => ({
      id: e.id,
      label: e.name,
      sub: [e.designation, e.department].filter(Boolean).join(' · '),
    }));

  /* A failed load is shown before the roster, so an outage can never be read as
     an empty staff or class list. */
  if (error) {
    return (
      <LoadErrorState
        title="Mark Attendance"
        subtitle="Record daily attendance"
        detail={error}
        onRetry={retry}
      />
    );
  }

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
          nouns={tab === 'student'
            ? { group: 'class', groups: 'classes', members: 'students', member: 'student', check: 'Check student' }
            : { group: 'employee', groups: 'employees', members: 'employees', member: 'employee', check: 'Check record' }}
          searchPlaceholder={tab === 'student' ? 'Search class, e.g. 10 - A' : 'Search employee by name…'}
        />
      )}
    </div>
  );
}