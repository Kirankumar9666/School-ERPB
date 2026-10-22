import { useCallback, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import toast from '../services/toast';
import api from '../services/api';
import { initials, todayISO } from '../utils/date';
import AttendanceMonthCalendar from './AttendanceMonthCalendar';
import LoadErrorState from './LoadErrorState';
import { describeLoadError } from '../utils/useLoadState';

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
 * Attendance is tracked TWICE per day — a Forenoon (FN) and an Afternoon (AN)
 * session, each stored and confirmed independently. The toolbar carries an
 * FN/AN toggle (defaulting to the session matching the current school time,
 * fully switchable regardless of the clock); switching it reloads THAT
 * session's saved roster, and "Confirm" submits only the selected session.
 *
 * "Give attendance" toggles absences in local state only and bulk-confirms the
 * whole group in one atomic request, with the 1-hour edit window after each
 * confirmation. "Check record" shows the month calendar from the saved
 * records. Every list, count and status comes from the API at request time —
 * nothing here is a local fixed list.
 *
 * A "group" is whatever the caller scoped: a class (several students) or a
 * single named employee. A one-person group therefore needs no member picker on
 * the check tab — the calendar simply belongs to that person — while a class
 * keeps its "choose a student" select. The optional `sub` on a group item is
 * the secondary line in the search results ("Senior Teacher · Mathematics"),
 * and the search matches it as well as the label.
 *
 * Mount it with a `key` tied to the active tab so switching tabs remounts it
 * with clean state (no stale roster from a previous group).
 *
 * @param {object} props
 * @param {'student'|'employee'} props.kind Which roster the group resolves to.
 * @param {Array<{id: string, label: string, studentCount?: number, sub?: string}>} props.groups
 *   Groups this caller may act on — already filtered to their permissions.
 * @param {string} props.apiBase '' for `/admin`, `/employees/<id>` for a teacher.
 * @param {object} props.nouns Wording for this context: { group, groups, members,
 *   member, check } — any omitted key falls back to the student/class default.
 * @param {string} [props.title] Heading above the search box.
 * @param {string} [props.searchPlaceholder]
 */

/** The two sessions of a school day — plain-language label per code. */
const SESSION_META = {
  FN: 'Forenoon (morning)',
  AN: 'Afternoon',
};

/** Default wording — the student/class context the teacher flow uses. */
const DEFAULT_NOUNS = {
  group: 'class',
  groups: 'classes',
  members: 'students',
  member: 'student',
  check: 'Check student',
};

/**
 * Which session "now" maps to, on the school clock (Asia/Kolkata — the whole
 * app's timezone): morning (before noon) is the FN session, after noon AN.
 * This is only the INITIAL default — the admin can switch freely afterwards.
 */
const sessionOfNow = () => {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()),
  );
  return hour < 12 ? 'FN' : 'AN';
};

export default function MarkAttendance({ kind, groups, apiBase, nouns, title, searchPlaceholder }) {
  /** Caller wording, with the student/class defaults filled in. */
  const words = { ...DEFAULT_NOUNS, ...nouns };

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null); // { groupKey, label }
  const [date, setDate] = useState(todayISO());
  const [session, setSession] = useState(sessionOfNow); // 'FN' | 'AN'
  const [group, setGroup] = useState(null); // { label, count, members, confirmation, session }
  const [groupLoading, setGroupLoading] = useState(false);
  // Set only when the roster read FAILED. Without it, a failed read left
  // `group` null with `groupLoading` false — the header then read "Loading…"
  // for ever over a body that had rendered nothing, which is a request that
  // never answered drawn on screen as one still being answered.
  const [groupError, setGroupError] = useState('');
  const [absentSet, setAbsentSet] = useState(() => new Set()); // local toggles only
  const [subTab, setSubTab] = useState('give'); // 'give' | 'check' inside a group
  const [savedNote, setSavedNote] = useState(null); // confirmation note after save
  const [overrideMode, setOverrideMode] = useState(false); // explicit past-edit unlock
  const [confirming, setConfirming] = useState(false);

  const [checkStudentId, setCheckStudentId] = useState('');

  /* Live filter: the label, plus `sub` (a designation/department) as the
     secondary match, so typing either half of a person's line finds them. */
  const term = query.trim().toLowerCase();
  const results = term
    ? groups.filter((g) => [g.label, g.sub].some((v) => String(v ?? '').toLowerCase().includes(term)))
    : groups;

  /** A one-person group has nobody to choose on the check tab. */
  const singleMember = group && group.members.length === 1 ? group.members[0] : null;

  /** Fetch the roster + saved statuses + confirmation state for the selection. */
  const loadGroup = useCallback(async (groupKey, forDate, forSession) => {
    setGroupLoading(true);
    try {
      const res = await api.get(`${apiBase}/attendance/group`, { params: { kind, groupKey, date: forDate, session: forSession } });
      const data = res.data.data;
      setGroup(data);
      setGroupError('');
      setAbsentSet(new Set(data.members.filter((m) => m.status === 'absent').map((m) => m.id)));
      setSavedNote(null);
      setOverrideMode(false);
    } catch (err) {
      toast.error(err.response?.data?.message || `Could not load the ${words.group}.`);
      setGroup(null);
      setGroupError(describeLoadError(err));
    } finally {
      setGroupLoading(false);
    }
  }, [apiBase, kind, words.group]);

  /** Re-run the roster read that just failed, for the selection still on screen. */
  const retryGroup = useCallback(() => {
    if (selected) loadGroup(selected.groupKey, date, session);
  }, [selected, date, session, loadGroup]);

  const selectGroup = (g) => {
    setSelected({ groupKey: g.id, label: g.label });
    setSubTab('give');
    setCheckStudentId('');
    setGroup(null); // clear the previous roster before the new read lands
    loadGroup(g.id, date, session);
  };

  /** Date change inside a selection re-reads that day's saved attendance. */
  const changeDate = (next) => {
    setDate(next);
    if (selected) loadGroup(selected.groupKey, next, session);
  };

  /** Session change re-reads the selected session's own roster + edit window. */
  const changeSession = (next) => {
    if (next === session) return;
    setSession(next);
    if (selected) loadGroup(selected.groupKey, date, next);
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

  /** One atomic request for the SELECTED session only: toggled members absent,
   *  everyone else present. The other session of the day is never touched. */
  const confirmAttendance = async () => {
    if (!group || !selected) return;
    setConfirming(true);
    try {
      const res = await api.post(`${apiBase}/attendance/bulk`, {
        kind,
        groupKey: selected.groupKey,
        date,
        session,
        override: overrideMode || undefined,
        entries: group.members.map((m) => ({
          entityId: m.id,
          status: absentSet.has(m.id) ? 'absent' : 'present',
        })),
      });
      const { absent, present } = res.data.data;
      toast.success(`Attendance confirmed for the ${SESSION_META[session]} session!`);
      await loadGroup(selected.groupKey, date, session); // refresh confirmation timestamp
      setSavedNote(`${SESSION_META[session]} attendance confirmed for ${date} — ${absent} absent · ${present} present.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not confirm attendance — nothing was saved.');
    } finally {
      setConfirming(false);
    }
  };

  /* "Check record" month calendar — see AttendanceMonthCalendar (shared) */


  return (
    <>
      {!selected && (
        <div className="card">
          {title && <div className="page-title" style={{ fontSize: 18, marginBottom: 'var(--sp-sm)' }}>{title}</div>}
          <div className="form-group">
            <label className="form-label" htmlFor="group-search">Search {words.group}</label>
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
              <div className="empty-state text-sm text-muted">
                {term ? `No ${words.groups} match “${query.trim()}”.` : `No ${words.groups} to show.`}
              </div>
            )}
            {results.map((g) => (
              <button key={g.id} type="button" className="att-result" onClick={() => selectGroup(g)}>
                <span>{g.label}</span>
                {/* `sub` (who this person is) when the caller supplies it,
                    otherwise the group's own size. */}
                <span className="text-sm text-muted">
                  {g.sub || `${g.studentCount} ${g.studentCount === 1 ? words.member : words.members}`}
                </span>
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
                {group
                  ? `${group.count} ${group.count === 1 ? words.member : words.members}`
                  : (groupLoading ? 'Loading…' : '')} · {date}
              </div>
            </div>
            <div className="att-toolbar">
              <div className="att-tool-group">
                <span className="att-tool-label">Date</span>
                <input type="date" className="form-input" style={{ maxWidth: 170 }} value={date} max={todayISO()} onChange={(e) => changeDate(e.target.value)} />
              </div>
              <div className="att-tool-divider" aria-hidden="true" />
              <div className="att-tool-group">
                <span className="att-tool-label">Session</span>
                <div className="att-session" role="group" aria-label="Attendance session (Forenoon / Afternoon)">
                  {['FN', 'AN'].map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`att-session-btn${session === s ? ' active' : ''}`}
                      aria-pressed={session === s}
                      disabled={groupLoading}
                      onClick={() => changeSession(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <button type="button" className="btn btn-secondary att-tool-change" onClick={() => { setSelected(null); setGroup(null); }}>
                Change {words.group}
              </button>
            </div>
          </div>

          <div className="att-session-line">
            Marking attendance for the <b>{SESSION_META[session]}</b> session.
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
            <button className={`tab-btn${subTab === 'check' ? ' active' : ''}`} onClick={() => setSubTab('check')}>{words.check}</button>
          </div>

          {/* A failed roster read must say so where the roster would have been,
              rather than leaving the tabs above over an empty body. */}
          {!groupLoading && groupError && (
            <LoadErrorState compact detail={groupError} onRetry={retryGroup} />
          )}

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
                <CheckCircle2 size={16} /> {confirming ? 'Confirming…' : `Confirm ${session} Attendance`}
              </button>
            </>
          )}

          {subTab === 'check' && (
            <>
              {/* A one-person group needs no picker — the calendar is that
                  person's record, read from their own live endpoint. */}
              {!singleMember && (
                <div className="form-group">
                  <label className="form-label" htmlFor="check-student">Student</label>
                  <select id="check-student" className="form-input" value={checkStudentId} onChange={(e) => setCheckStudentId(e.target.value)}>
                    <option value="">— choose —</option>
                    {(group?.members || []).map((m) => (
                      <option key={m.id} value={m.id}>{m.rollNumber ? `${m.rollNumber} · ` : ''}{m.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {(singleMember || checkStudentId) && (
                <AttendanceMonthCalendar
                  personId={singleMember ? singleMember.id : checkStudentId}
                  kind={kind}
                />
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
