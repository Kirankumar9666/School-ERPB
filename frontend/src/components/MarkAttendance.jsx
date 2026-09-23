import { useCallback, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../services/api';
import { initials, todayISO } from '../utils/date';
import AttendanceMonthCalendar from './AttendanceMonthCalendar';

/**
 * Search → select → act, for one attendance group.
 *
 * This is the single implementation of the "Mark Attendance" flow: the admin
 * panel (`AdminAttendance`) and the teacher view inside the employee portal
 * (`EmployeeAttendance`) both render it, so the two can never drift apart.
 * The only differences come in as props — the group list the caller has
 * already scoped (`groups`), the API base that enforces the caller's
 * permissions (`apiBase`), and the wording (`kind`, `nouns`).
 *
 * "Give attendance" toggles absences in local state only and bulk-confirms the
 * whole group in one atomic request, with the 1-hour edit window after each
 * confirmation. "Check student" shows the month calendar from the saved
 * records. Every list, count and status comes from the API at request time —
 * nothing here is a local fixed list.
 *
 * Mount it with a `key` tied to the active tab so switching tabs remounts it
 * with clean state (no stale roster from a previous group).
 *
 * @param {object} props
 * @param {'student'|'employee'} props.kind Which roster the group resolves to.
 * @param {Array<{id: string, label: string, studentCount: number}>} props.groups
 *   Groups this caller may act on — already filtered to their permissions.
 * @param {string} props.apiBase '' for `/admin`, `/employees/<id>` for a teacher.
 * @param {object} props.nouns { group, groups, members } words for this context.
 * @param {string} [props.title] Heading above the search box.
 * @param {string} [props.searchPlaceholder]
 */
export default function MarkAttendance({ kind, groups, apiBase, nouns, title, searchPlaceholder }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null); // { groupKey, label }
  const [date, setDate] = useState(todayISO());
  const [group, setGroup] = useState(null); // { label, count, members, confirmation }
  const [groupLoading, setGroupLoading] = useState(false);
  const [absentSet, setAbsentSet] = useState(() => new Set()); // local toggles only
  const [subTab, setSubTab] = useState('give'); // 'give' | 'check' inside a group
  const [savedNote, setSavedNote] = useState(null); // confirmation note after save
  const [overrideMode, setOverrideMode] = useState(false); // explicit past-edit unlock
  const [confirming, setConfirming] = useState(false);

  const [checkStudentId, setCheckStudentId] = useState('');

  const results = groups.filter((g) => g.label.toLowerCase().includes(query.trim().toLowerCase()));

  /** Fetch the roster + saved statuses + confirmation state for the selection. */
  const loadGroup = useCallback(async (groupKey, forDate) => {
    setGroupLoading(true);
    try {
      const res = await api.get(`${apiBase}/attendance/group`, { params: { kind, groupKey, date: forDate } });
      const data = res.data.data;
      setGroup(data);
      setAbsentSet(new Set(data.members.filter((m) => m.status === 'absent').map((m) => m.id)));
      setSavedNote(null);
      setOverrideMode(false);
    } catch (err) {
      toast.error(err.response?.data?.message || `Could not load the ${nouns.group}.`);
      setGroup(null);
    } finally {
      setGroupLoading(false);
    }
  }, [apiBase, kind, nouns.group]);

  const selectGroup = (g) => {
    setSelected({ groupKey: g.id, label: g.label });
    setSubTab('give');
    setCheckStudentId('');
    setGroup(null); // clear the previous roster before the new read lands
    loadGroup(g.id, date);
  };

  /** Date change inside a selection re-reads that day's saved attendance. */
  const changeDate = (next) => {
    setDate(next);
    if (selected) loadGroup(selected.groupKey, next);
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
      const res = await api.post(`${apiBase}/attendance/bulk`, {
        kind,
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
      await loadGroup(selected.groupKey, date); // refresh confirmation timestamp
      setSavedNote(`Attendance confirmed for ${date} — ${absent} absent · ${present} present.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not confirm attendance — nothing was saved.');
    } finally {
      setConfirming(false);
    }
  };

  /* "Check student" month calendar — see AttendanceMonthCalendar (shared) */


  return (
    <>
      {!selected && (
        <div className="card">
          {title && <div className="page-title" style={{ fontSize: 18, marginBottom: 'var(--sp-sm)' }}>{title}</div>}
          <div className="form-group">
            <label className="form-label" htmlFor="group-search">Search {nouns.group}</label>
            <input
              id="group-search"
              className="form-input"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="att-results">
            {results.length === 0 && (
              <div className="empty-state text-sm text-muted">No matching {nouns.groups}.</div>
            )}
            {results.map((g) => (
              <button key={g.id} type="button" className="att-result" onClick={() => selectGroup(g)}>
                <span>{g.label}</span>
                <span className="text-sm text-muted">{g.studentCount} {nouns.members}</span>
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
                {group ? `${group.count} ${nouns.members}` : 'Loading…'} · {date}
              </div>
            </div>
            <input type="date" className="form-input" style={{ maxWidth: 170 }} value={date} max={todayISO()} onChange={(e) => changeDate(e.target.value)} />
            <button type="button" className="btn btn-secondary" onClick={() => { setSelected(null); setGroup(null); }}>
              Change {nouns.group}
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
              <div className="att-summary" aria-label="Live attendance counts">
                <div className="att-pill">
                  Present <b>{group.count - absentSet.size}</b>
                </div>
                <div className={`att-pill absent${absentSet.size ? ' alert' : ''}`}>
                  Absent <b>{absentSet.size}</b>
                </div>
              </div>
              <div className="att-roster">
                {group.members.map((m) => {
                  const absent = absentSet.has(m.id);
                  return (
                    <div key={m.id} className="att-row">
                      <div className="att-avatar" aria-hidden="true">{initials(m.name)}</div>
                      <div className="att-member">
                        <div className="att-member-name">
                          <span className="att-name">{m.name}</span>
                          {m.rollNumber && <span className="att-roll">{m.rollNumber}</span>}
                        </div>
                        <div className="att-member-meta">
                          {m.parentName}{m.guardianContact ? ` · ${m.guardianContact}` : ''}
                        </div>
                      </div>
                      <div className="att-seg" role="group" aria-label={`Attendance for ${m.name}`}>
                        <button
                          type="button"
                          className={`att-seg-btn${!absent ? ' active present' : ''}`}
                          disabled={!editable}
                          aria-pressed={!absent}
                          onClick={() => absent && toggleAbsent(m.id)}
                        >
                          Present
                        </button>
                        <button
                          type="button"
                          className={`att-seg-btn${absent ? ' active absent' : ''}`}
                          disabled={!editable}
                          aria-pressed={absent}
                          onClick={() => !absent && toggleAbsent(m.id)}
                        >
                          Absent
                        </button>
                      </div>
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
                <AttendanceMonthCalendar studentId={checkStudentId} />
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
