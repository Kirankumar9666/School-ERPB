import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import api from '../../services/api';
import { loadOptions, optionLabel } from '../../services/options';
import toast from 'react-hot-toast';
import { buildCalendar, monthLabel, monthShift, todayISO } from '../../utils/date';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Admin Attendance — search → select → act, per group (Students tab: a class;
 * Employees tab: a designation group). "Give attendance" toggles absences in
 * local state only and bulk-confirms the whole group in one atomic request
 * (1-hour edit window after each confirmation). "Check student" shows the
 * month calendar from the saved records. Every list, count and status comes
 * from the API at request time — nothing is a local fixed list.
 */
export default function AdminAttendance() {
  const [tab, setTab] = useState('student'); // top-level Students / Employees tabs
  const [classes, setClasses] = useState([]); // live class list (options API)
  const [employees, setEmployees] = useState([]); // live employee list
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  const [selected, setSelected] = useState(null); // { kind, groupKey, label }
  const [date, setDate] = useState(todayISO());
  const [group, setGroup] = useState(null); // { label, count, members, confirmation }
  const [groupLoading, setGroupLoading] = useState(false);
  const [absentSet, setAbsentSet] = useState(() => new Set()); // local toggles only
  const [subTab, setSubTab] = useState('give'); // 'give' | 'check' inside a class
  const [savedNote, setSavedNote] = useState(null); // confirmation note after save
  const [overrideMode, setOverrideMode] = useState(false); // explicit past-edit unlock
  const [confirming, setConfirming] = useState(false);

  const [checkStudentId, setCheckStudentId] = useState('');
  const [monthOffset, setMonthOffset] = useState(0);
  const [monthRecords, setMonthRecords] = useState({}); // 'YYYY-MM-DD' → status

  useEffect(() => {
    Promise.all([api.get('/admin/employees'), loadOptions()])
      .then(([e, o]) => {
        setEmployees(e.data.data);
        setClasses(o.classes);
      })
      .finally(() => setLoading(false));
  }, []);

  /** Live group list for the current tab — classes or designation groups. */
  const groups = tab === 'student'
    ? classes
    : Object.entries(
      employees.reduce((acc, emp) => {
        const key = emp.designation || 'Unassigned';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    ).map(([designation, count]) => ({ id: designation, label: optionLabel(designation), studentCount: count }));

  const results = groups.filter((g) => g.label.toLowerCase().includes(query.trim().toLowerCase()));

  /** Fetch the roster + saved statuses + confirmation state for the selection. */
  const loadGroup = useCallback(async (kind, groupKey, forDate) => {
    setGroupLoading(true);
    try {
      const res = await api.get('/admin/attendance/group', { params: { kind, groupKey, date: forDate } });
      const data = res.data.data;
      setGroup(data);
      setAbsentSet(new Set(data.members.filter((m) => m.status === 'absent').map((m) => m.id)));
      setSavedNote(null);
      setOverrideMode(false);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the group.');
      setGroup(null);
    } finally {
      setGroupLoading(false);
    }
  }, []);

  const selectGroup = (kind, g) => {
    setTab(kind);
    setSelected({ kind, groupKey: g.id, label: g.label });
    setSubTab('give');
    setCheckStudentId('');
    loadGroup(kind, g.id, date);
  };

  /** Date change inside a selection re-reads that day's saved attendance. */
  const changeDate = (next) => {
    setDate(next);
    if (selected) loadGroup(selected.kind, selected.groupKey, next);
  };

  const editable = Boolean(group && (!group.confirmation || group.confirmation.withinEditWindow || overrideMode));

  const toggleAbsent = (id) => {
    if (!editable) return;
    setAbsentSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSavedNote(null); // edits after a confirm hide the note until re-confirmed
  };

  /** One atomic request: toggled members absent, everyone else present. */
  const confirmAttendance = async () => {
    if (!group || !selected) return;
    setConfirming(true);
    try {
      const res = await api.post('/admin/attendance/bulk', {
        kind: selected.kind,
        groupKey: selected.groupKey,
        date,
        override: overrideMode || undefined,
        entries: group.members.map((m) => ({
          entityId: m.id,
          status: absentSet.has(m.id) ? 'absent' : 'present',
        })),
      });
      const { absent, present } = res.data.data;
      toast.success('Attendance confirmed!');
      await loadGroup(selected.kind, selected.groupKey, date); // refresh confirmation timestamp
      setSavedNote(`Attendance confirmed for ${date} — ${absent} absent · ${present} present.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not confirm attendance — nothing was saved.');
    } finally {
      setConfirming(false);
    }
  };

  /** "Check student" month calendar — real saved records for that student. */
  useEffect(() => {
    if (subTab !== 'check' || !checkStudentId) return undefined;
    const { key } = monthShift(monthOffset);
    let alive = true;
    api.get(`/students/${checkStudentId}/attendance`, { params: { month: key } })
      .then((res) => { if (alive) setMonthRecords(res.data.data.records || {}); })
      .catch(() => { if (alive) setMonthRecords({}); });
    return () => { alive = false; };
  }, [subTab, checkStudentId, monthOffset]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  /* Calendar view state for "Check student" */
  const view = monthShift(monthOffset);
  const calCells = buildCalendar(view.year, view.month);
  const isWeekend = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return d.getDay() === 0 || d.getDay() === 6;
  };
  const dayClass = (iso) => {
    const rec = monthRecords[iso];
    if (rec === 'present') return 'present';
    if (rec === 'absent') return 'absent';
    if (rec === 'half-day') return 'halfday';
    return isWeekend(iso) ? 'holiday' : ''; // weekends with no record = no school
  };
  const monthCounts = Object.values(monthRecords).reduce(
    (acc, s) => {
      if (s === 'present') acc.present += 1;
      else if (s === 'absent') acc.absent += 1;
      else if (s === 'half-day') acc.halfDay += 1;
      return acc;
    },
    { present: 0, absent: 0, halfDay: 0 },
  );
  const peopleNoun = tab === 'student' ? 'students' : 'members';

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Mark Attendance</div>
        <div className="page-subtitle">Record daily attendance</div>
      </div>

      {/* Top-level tabs — unchanged */}
      <div className="tabs">
        <button className={`tab-btn${tab === 'student' ? ' active' : ''}`} onClick={() => { setTab('student'); setSelected(null); setGroup(null); setQuery(''); }}>Students</button>
        <button className={`tab-btn${tab === 'employee' ? ' active' : ''}`} onClick={() => { setTab('employee'); setSelected(null); setGroup(null); setQuery(''); }}>Employees</button>
      </div>

      {!selected && (
        <div className="card">
          <div className="form-group">
            <label className="form-label" htmlFor="group-search">Search {tab === 'student' ? 'class' : 'staff group'}</label>
            <input
              id="group-search"
              className="form-input"
              placeholder={tab === 'student' ? 'Search class, e.g. 10 - A' : 'Search designation, e.g. Teacher'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="att-results">
            {results.length === 0 && (
              <div className="empty-state text-sm text-muted">No matching {tab === 'student' ? 'classes' : 'groups'}.</div>
            )}
            {results.map((g) => (
              <button key={g.id} type="button" className="att-result" onClick={() => selectGroup(tab, g)}>
                <span>{g.label}</span>
                <span className="text-sm text-muted">{g.studentCount} {peopleNoun}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <div className="card">
          <div className="att-class-head">
            <div>
              <div className="page-title" style={{ fontSize: 20 }}>{group?.label || selected.label}</div>
              <div className="text-sm text-muted">
                {group ? `${group.count} ${peopleNoun}` : 'Loading…'} · {date}
              </div>
            </div>
            <input type="date" className="form-input" style={{ maxWidth: 170 }} value={date} max={todayISO()} onChange={(e) => changeDate(e.target.value)} />
            <button type="button" className="btn btn-secondary" onClick={() => { setSelected(null); setGroup(null); }}>
              Change class
            </button>
          </div>

          {group?.confirmation && (
            <div className={`att-note${group.confirmation.withinEditWindow ? '' : ' locked'}`}>
              {group.confirmation.withinEditWindow
                ? `Confirmed at ${new Date(group.confirmation.confirmedAt).toLocaleTimeString()} — editable for the next hour.`
                : 'Edit window closed — re-confirming requires “Edit past attendance”.'}
              {!group.confirmation.withinEditWindow && !overrideMode && (
                <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 'var(--sp-sm)' }} onClick={() => setOverrideMode(true)}>
                  Edit past attendance
                </button>
              )}
            </div>
          )}
          {savedNote && <div className="att-note ok">{savedNote}</div>}

          <div className="tabs">
            <button className={`tab-btn${subTab === 'give' ? ' active' : ''}`} onClick={() => setSubTab('give')}>Give attendance</button>
            <button className={`tab-btn${subTab === 'check' ? ' active' : ''}`} onClick={() => setSubTab('check')}>Check student</button>
          </div>

          {subTab === 'give' && group && (
            <>
              <div className="att-summary">
                {absentSet.size} marked absent · {group.count - absentSet.size} present
              </div>
              <div className="att-roster">
                {group.members.map((m) => {
                  const absent = absentSet.has(m.id);
                  return (
                    <div key={m.id} className="att-row">
                      <div>
                        <div style={{ fontWeight: 600 }}>{m.rollNumber ? `${m.rollNumber} · ` : ''}{m.name}</div>
                        <div className="text-sm text-muted">{m.parentName}{m.guardianContact ? ` · ${m.guardianContact}` : ''}</div>
                      </div>
                      <button
                        type="button"
                        className={`att-toggle${absent ? ' absent' : ''}`}
                        disabled={!editable}
                        aria-pressed={absent}
                        onClick={() => toggleAbsent(m.id)}
                      >
                        {absent ? 'Absent' : 'Present'}
                      </button>
                    </div>
                  );
                })}
              </div>
              <button type="button" className="btn btn-primary" disabled={!editable || confirming || groupLoading} onClick={confirmAttendance}>
                <CheckCircle2 size={16} /> {confirming ? 'Confirming…' : 'Confirm attendance'}
              </button>
            </>
          )}

          {subTab === 'check' && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="check-student">Student</label>
                <select id="check-student" className="form-input" value={checkStudentId} onChange={(e) => setCheckStudentId(e.target.value)}>
                  <option value="">— choose —</option>
                  {(group?.members || []).map((m) => (
                    <option key={m.id} value={m.id}>{m.rollNumber ? `${m.rollNumber} · ` : ''}{m.name}</option>
                  ))}
                </select>
              </div>
              {checkStudentId && (
                <div className="att-calendar">
                  <div className="att-cal-head">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonthOffset((o) => o - 1)} aria-label="Previous month">‹</button>
                    <strong>{monthLabel(view.year, view.month)}</strong>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonthOffset((o) => o + 1)} aria-label="Next month">›</button>
                  </div>
                  <div className="att-cal-grid">
                    {WEEKDAYS.map((d) => <div key={d} className="att-cal-dow">{d}</div>)}
                    {calCells.map((iso) => iso && (
                      <div key={iso} className={`att-cal-day ${dayClass(iso)}`.trim()} title={monthRecords[iso] || undefined}>
                        {Number(iso.slice(-2))}
                      </div>
                    ))}
                  </div>
                  <div className="text-sm text-muted">
                    {monthCounts.present} present · {monthCounts.absent} absent{monthCounts.halfDay ? ` · ${monthCounts.halfDay} half-day` : ''}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}