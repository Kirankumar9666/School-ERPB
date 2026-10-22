import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ClipboardList, Plus, Save, Search, Trash2, UserPlus, X } from 'lucide-react';
import PhoneInput from './PhoneInput';
import LoadErrorState from './LoadErrorState';
import api from '../services/api';
import toast from '../services/toast';
import { describeLoadError } from '../utils/useLoadState';
import { fieldToContact } from '../utils/phone';
import { useSubmitGuard } from '../utils/useSubmitGuard';

/**
 * Enter Past Data — type in a year the school never entered live.
 *
 * ## The identity problem, stated once
 *
 * Next year, when this batch is promoted, the office needs to know that the
 * "Rahul Menon" in 2022-23 is the same child sitting in 9B today. Roll numbers
 * cannot answer that — they are reassigned every year — so the matching key is
 * **name + guardian name + guardian contact**, typed from the paper register and
 * stored against the child. This tab therefore requires all three up front and
 * says why, rather than accepting a name and hoping.
 *
 * A child typed in here who does not already exist is created with a `null`
 * current class: a historical record says nothing about where anyone is today, so
 * it must not make somebody appear on a present-day register. They are found next
 * year by the same three fields, in the promotion review screen.
 *
 * ## Attendance is a yearly total, not a calendar
 *
 * A register filled in after the fact records "present 178 of 210", not 210 days.
 * So this tab asks for the three figures and stores them as such — there is no day
 * picker here, and offering one would invite 210 fabricated rows.
 *
 * ## Re-saving a year corrects it
 *
 * Picking a student who ALREADY has a record for this year loads that record into
 * the form. The save then overwrites it in place, so a typo in last year's entry is
 * fixable; without the prefill, the in-place correction the server supports would
 * be unreachable from the UI.
 *
 * @param {Array} props.years every academic year, newest first (from the page)
 */
const EMPTY_ATTENDANCE = { workingDays: '', daysPresent: '', daysAbsent: '' };
const blankMark = () => ({ examName: '', subject: '', maxMarks: '', obtained: '' });

/**
 * Tier wording for a search hit. The tier is computed by the server, never asked
 * for — the client cannot promote its own query to "exact".
 *
 * Only an exact hit is worth trusting without checking the register. Anything else
 * is shown with its weakness named, because "3 results" invites picking the first
 * one, and the whole point of matching on three fields is that a human confirms
 * the coincidence.
 */
const TIER_TEXT = {
  exact: 'exact match',
  partial: 'possible match',
  weak: 'weak match',
};
const TIER_BADGE = { exact: 'badge-active', partial: 'badge-warning', weak: 'badge-danger' };
/** Merge order when the same child comes back from two queries: the stronger match wins. */
const TIER_RANK = { exact: 0, partial: 1, weak: 2, none: 3 };

/**
 * One box, three kinds of query — and the server needs telling WHICH kind.
 *
 * The endpoint takes `name`, `parentName` and `guardianContact` separately, and it
 * narrows candidates in the DATABASE using the name tokens alone. That has a sharp
 * consequence the box has to absorb: typing a contact into it as a *name* produces
 * `name contains '9876543210'`, which matches no student on earth — a guardian's
 * number would silently return nothing rather than the child it belongs to.
 *
 * So the input is classified before it is sent. Digits can only be a contact. Text
 * is genuinely ambiguous — "Rajesh Kumar" is one child's guardian as easily as it is
 * another's name — so it is sent BOTH ways and the hits merged, since only one of
 * the two queries can be the right reading.
 */
const looksLikeContact = (value) => /^[\d\s()+.-]{6,}$/.test(value.trim());

export default function ClassManagementPastData({ years }) {
  const [yearId, setYearId] = useState('');
  const [classId, setClassId] = useState('');
  const [classes, setClasses] = useState([]);
  const [loadingClasses, setLoadingClasses] = useState(false);

  /* The year picker offers only PAST years. Entering the current year through this
     form would write a record flagged `historical` about a year that is still
     running and already has live attendance against it — a backfill of a year
     nobody has finished. Current-year entry belongs in Marks Entry. */
  const pastYears = useMemo(() => years.filter((y) => !y.isCurrent), [years]);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null); // null = not searched yet
  // Set only when the SEARCH REQUEST failed. Without it the catch below handed
  // back an empty result list, and "Nobody on file matches ..." is a statement
  // about the register — not something we can say when we never got an answer.
  const [searchError, setSearchError] = useState('');
  const [subject, setSubject] = useState(null); // { studentId?, name, parentName, guardianContact }
  const [creating, setCreating] = useState(false);
  const [newStudent, setNewStudent] = useState({ name: '', parentName: '', guardianContact: '', rollNumber: '' });
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [existingRecord, setExistingRecord] = useState(null);

  const [attendance, setAttendance] = useState(EMPTY_ATTENDANCE);
  const [marks, setMarks] = useState([blankMark()]);
  const [saving, setSaving] = useState(false);
  const [guard, cooling] = useSubmitGuard(900);

  const resetSubject = useCallback(() => {
    setSubject(null);
    setCreating(false);
    setResults(null);
    setNewStudent({ name: '', parentName: '', guardianContact: '', rollNumber: '' });
    setAttendance(EMPTY_ATTENDANCE);
    setMarks([blankMark()]);
    setExistingRecord(null);
    setQuery('');
  }, []);

  useEffect(() => {
    if (!yearId && pastYears.length) setYearId(pastYears[0].id);
  }, [pastYears, yearId]);

  /* Changing either selector throws away a half-filled record: its class would no
     longer be the one chosen, and silently re-filing it elsewhere is exactly the
     mistake this feature exists to prevent. */
  useEffect(() => {
    resetSubject();
    if (!yearId) { setClasses([]); setClassId(''); return; }
    let alive = true;
    setLoadingClasses(true);
    setClassId('');
    api.get(`/admin/class-management/years/${yearId}/classes`)
      .then((res) => { if (alive) setClasses(res.data.data || []); })
      .catch((err) => {
        if (!alive) return;
        setClasses([]);
        toast.error(err.response?.data?.message || 'Could not load the classes for that year');
      })
      .finally(() => { if (alive) setLoadingClasses(false); });
    return () => { alive = false; };
  }, [yearId, resetSubject]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const search = (params) =>
        api.get('/admin/class-management/students/search', { params });
      const responses = looksLikeContact(q)
        ? [await search({ guardianContact: q })]
        : await Promise.all([search({ name: q }), search({ parentName: q })]);

      /* The same child can answer both text queries (a name that is also a
         guardian's surname elsewhere); keep the stronger of the two readings so
         one child never appears twice in the list. */
      const merged = new Map();
      responses.forEach((r) => (r.data.data || []).forEach((row) => {
        const seen = merged.get(row.studentId);
        if (!seen || TIER_RANK[row.tier] < TIER_RANK[seen.tier]) merged.set(row.studentId, row);
      }));
      setResults([...merged.values()]);
      setSearchError('');
    } catch (err) {
      setResults([]);
      setSearchError(describeLoadError(err));
      toast.error(err.response?.data?.message || 'Could not search for that student');
    } finally {
      setSearching(false);
    }
  };

  /** Re-run the search that just failed, with the query still in the box. */
  const retrySearch = () => {
    setSearchError('');
    runSearch();
  };

  /** Attach to an existing student, prefilling from any record they already hold. */
  const chooseExisting = async (hit) => {
    setSubject({
      studentId: hit.studentId,
      name: hit.name,
      parentName: hit.parentName,
      guardianContact: hit.guardianContact,
    });
    setCreating(false);
    setLoadingExisting(true);
    setExistingRecord(null);
    try {
      // Pre-existing entries for this year are loaded so the form becomes an edit
      // rather than an append.
      const res = await api.get(
        `/admin/class-management/students/${hit.studentId}/years/${yearId}`,
      );
      const view = res.data.data;
      const enr = view.enrollment;
      const bf = view.attendance?.backfilled;
      setAttendance(bf
        ? {
          workingDays: String(bf.workingDays),
          daysPresent: String(bf.daysPresent),
          daysAbsent: String(bf.daysAbsent),
        }
        : EMPTY_ATTENDANCE);
      setMarks(view.marks?.length
        ? view.marks.map((m) => ({
          examName: m.examName,
          subject: m.subject,
          maxMarks: String(m.maxMarks),
          obtained: String(m.obtained),
        }))
        : [blankMark()]);
      setExistingRecord(enr ? { classLabel: enr.classLabel, rollNumber: enr.rollNumber } : null);
      /* The roll number MUST come back into the field. Leaving it blank would send
         `rollNumber: null` on save and silently wipe the number the register for
         that year already carried — the admin would have to open a form to erase a
         value by never touching it. */
      setSubject((s) => ({ ...s, rollNumber: enr?.rollNumber ?? '' }));
    } catch {
      // No record for this year (or none at all) — start empty rather than fail. The
      // save is what decides whether this child can be filed here.
      setAttendance(EMPTY_ATTENDANCE);
      setMarks([blankMark()]);
      setSubject((s) => ({ ...s, rollNumber: '' }));
    } finally {
      setLoadingExisting(false);
    }
  };

  const startCreating = () => {
    setCreating(true);
    setResults([]);
    setSubject(null);
  };

  const addMarkRow = () => setMarks((m) => [...m, blankMark()]);
  const setMark = (i, key) => (value) => setMarks((m) => m.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  const removeMarkRow = (i) => setMarks((m) => (m.length === 1 ? [blankMark()] : m.filter((_, j) => j !== i)));

  /* Client-side guard on the one rule that is not cosmetic: obtained cannot exceed
     the maximum. The server refuses it too, but per-row highlighting here beats a
     single toast naming row 4 of a list the office is still looking at. */
  const markErrors = marks.map((r) => {
    if (!r.examName.trim() && !r.subject.trim() && !r.maxMarks && !r.obtained) return null;
    if (!r.examName.trim() || !r.subject.trim()) return 'Exam name and subject are required';
    if (Number(r.maxMarks) < 1) return 'Max marks must be above 0';
    if (r.obtained === '' || Number.isNaN(Number(r.obtained))) return 'Obtained is required';
    if (Number(r.obtained) < 0) return 'Obtained cannot be negative';
    if (Number(r.obtained) > Number(r.maxMarks)) return `Obtained cannot be above ${r.maxMarks}`;
    return null;
  });
  const usableMarks = marks.filter((r, i) => !(markErrors[i] === null && !r.examName.trim()));
  const hasMarkErrors = markErrors.some(Boolean);

  const attFilled = attendance.workingDays !== '' || attendance.daysPresent !== '' || attendance.daysAbsent !== '';
  const attError = attFilled && (
    attendance.workingDays === '' || attendance.daysPresent === '' || attendance.daysAbsent === ''
      ? 'Working days, days present and days absent all go together'
      : Number(attendance.daysPresent) + Number(attendance.daysAbsent) > Number(attendance.workingDays)
        ? `Present and absent cannot exceed the ${attendance.workingDays} working days`
        : null
  );

  const newStudentMissing = creating && (!newStudent.name.trim() || !newStudent.parentName.trim() || newStudent.guardianContact.length !== 10);
  const canSave = Boolean(yearId && classId && subject && !attError && !hasMarkErrors && !newStudentMissing && !saving && !cooling && !loadingExisting);

  const save = async () => {
    if (!canSave || !subject) return;
    setSaving(true);
    try {
      /* `rollNumber` is TOP-LEVEL for both branches. It is a property of the year's
         enrollment, not of the child's identity, and the server's schema strips
         unknown keys — so a copy nested inside `newStudent` is discarded without a
         word and the roll number the office typed for that year is simply lost. */
      const rollNumber = subject.studentId
        ? subject.rollNumber?.trim() || null
        : newStudent.rollNumber.trim() || null;

      const payload = {
        academicYearId: yearId,
        classId,
        rollNumber,
        ...(subject.studentId
          ? { existingStudentId: subject.studentId }
          : {
            newStudent: {
              name: newStudent.name.trim(),
              parentName: newStudent.parentName.trim(),
              guardianContact: fieldToContact(newStudent.guardianContact),
            },
          }),
        ...(attFilled ? {
          attendance: {
            workingDays: Number(attendance.workingDays),
            daysPresent: Number(attendance.daysPresent),
            daysAbsent: Number(attendance.daysAbsent),
          },
        } : {}),
        marks: usableMarks.map((r) => ({
          examName: r.examName.trim(),
          subject: r.subject.trim(),
          maxMarks: Number(r.maxMarks),
          obtained: Number(r.obtained),
        })),
      };
      const res = await api.post('/admin/class-management/historical-records', payload);
      toast.success(res.data.message);
      resetSubject();
      /* The class now holds a student for this year, so the list of classes and the
         "who is in it" count have both moved. Refetched rather than patched so the
         numbers cannot drift from the database. */
      if (yearId) {
        const cls = await api.get(`/admin/class-management/years/${yearId}/classes`);
        setClasses(cls.data.data || []);
      }
    } catch (err) {
      const body = err.response?.data;
      const field = body?.errors ? Object.values(body.errors).flat()[0] : null;
      toast.error(field || body?.message || 'Could not save the historical record');
    } finally {
      setSaving(false);
    }
  };

  const selectedYear = pastYears.find((y) => y.id === yearId);
  const usedCount = (c) => c.historyCount ?? 0;

  return (
    <>
      <div className="att-note" style={{ marginBottom: 'var(--sp-lg)' }}>
        <div>
          <strong>Everything here is stored as a historical record</strong>, tagged to
          the year and class you choose and kept separate from the live register — so
          it can never be mistaken for something the school recorded day to day.
        </div>
        <div className="text-sm text-muted" style={{ marginTop: 4 }}>
          A child&apos;s current class and roll number are left untouched: a record of
          2022-23 says nothing about where they are today.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 'var(--sp-lg)' }}>
        <div className="form-grid-2">
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="cm-past-year">Academic Year</label>
            <select
              id="cm-past-year"
              className="form-input"
              value={yearId}
              onChange={(e) => setYearId(e.target.value)}
            >
              {pastYears.length === 0 && <option value="">No past years on file</option>}
              {pastYears.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}
            </select>
            <span className="form-help">
              The current year is not listed — entry for a year still running belongs
              in Marks Entry and Attendance, not here.
            </span>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="cm-past-class">Class (as of that year)</label>
            <select
              id="cm-past-class"
              className="form-input"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              disabled={!yearId || loadingClasses}
            >
              <option value="">
                {loadingClasses ? 'Loading classes…' : yearId ? 'Choose a class' : 'Choose a year first'}
              </option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}{usedCount(c) ? ` — ${usedCount(c)} already recorded` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {!yearId || !classId ? (
        <div className="empty-state">Choose an academic year and a class to start.</div>
      ) : (
        <>
          {/* ── Step 1: who? ───────────────────────────────────────────── */}
          {!subject && (
            <div className="section">
              <div className="section-title"><Search size={14} /> 1. Find the student</div>
              <div className="card">
                <div className="form-group" style={{ marginBottom: 'var(--sp-md)' }}>
                  <label className="form-label" htmlFor="cm-search">Student, guardian name or contact</label>
                  <div className="input-wrapper">
                    <Search size={15} className="input-icon" />
                    <input
                      id="cm-search"
                      className="form-input"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && query.trim() && !searching) runSearch(); }}
                      placeholder="e.g. Rahul Menon · Rajesh Kumar · 9876543210"
                      disabled={creating}
                    />
                  </div>
                  <span className="form-help">
                    Matched on name, guardian name and guardian contact — the three
                    fields that identify a child across years, and the same ones
                    promotion uses, so the two features can never disagree about who
                    a child is. A number is recognised as a contact on its own.
                  </span>
                </div>

                {!creating && (
                  <div className="mk-actions" style={{ marginBottom: results ? 'var(--sp-md)' : 0 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={runSearch}
                      disabled={!query.trim() || searching}
                    >
                      <Search size={15} /> {searching ? 'Searching…' : 'Search'}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={startCreating}>
                      <UserPlus size={15} /> Add them as a historical record
                    </button>
                  </div>
                )}

                {searching && <div className="loading-center"><div className="spinner" /></div>}

                {!searching && results && !creating && (
                  searchError ? (
                    <LoadErrorState
                      compact
                      detail={searchError}
                      onRetry={retrySearch}
                      icon={Search}
                    />
                  ) : results.length === 0 ? (
                    <div className="empty-state" style={{ marginTop: 'var(--sp-md)' }}>
                      Nobody on file matches &ldquo;{query}&rdquo;.
                      <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
                        Check the spelling, or add this child as a historical record
                        below — they will then be found next year by name, guardian name
                        and contact when their class is promoted.
                      </div>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 'var(--sp-md)' }} onClick={startCreating}>
                        <UserPlus size={14} /> Add as a historical record
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="info-note" style={{ marginBottom: 'var(--sp-sm)' }}>
                        {results.length} possible match{results.length === 1 ? '' : 'es'} —
                        pick the right child. Anything not marked &ldquo;exact&rdquo; is
                        worth checking against the register before you continue.
                      </div>
                      <div className="table-wrapper">
                        <table>
                          <thead>
                            <tr>
                              <th>Name</th>
                              <th>Match</th>
                              <th>Guardian</th>
                              <th>Contact</th>
                              <th>Now in</th>
                              <th>Years already recorded</th>
                              <th style={{ width: 90 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {results.map((r) => {
                              const inThisYear = r.years.some((y) => y.academicYearId === yearId);
                              return (
                                <tr key={r.studentId}>
                                  <td className="mk-saved-name">{r.name}</td>
                                  <td>
                                    <span className={`badge ${TIER_BADGE[r.tier] || 'badge-muted'}`}>
                                      {TIER_TEXT[r.tier] || r.tier}
                                    </span>
                                  </td>
                                  <td>{r.parentName || <span className="text-muted">not on file</span>}</td>
                                  <td>{r.guardianContact || <span className="text-muted">not on file</span>}</td>
                                  <td>
                                    {r.currentClassLabel || <span className="text-muted">no current class</span>}
                                  </td>
                                  <td>
                                    <div className="mk-chips">
                                      {r.years.map((y) => (
                                        <span
                                          key={y.academicYearId}
                                          className={`mk-chip${y.academicYearId === yearId ? ' active' : ''}`}
                                          style={{ cursor: 'default' }}
                                        >
                                          {y.academicYearLabel} · {y.classLabel}
                                        </span>
                                      ))}
                                      {r.years.length === 0 && <span className="text-sm text-muted">none</span>}
                                    </div>
                                  </td>
                                  <td>
                                    <button
                                      type="button"
                                      className="btn btn-secondary btn-sm"
                                      onClick={() => chooseExisting(r)}
                                    >
                                      {inThisYear ? 'Edit' : 'Select'}
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )
                )}

                {/* ── New historical child ────────────────────────────────── */}
                {creating && (
                  <div style={{ marginTop: 'var(--sp-md)' }}>
                    <div className="att-note locked" style={{ marginBottom: 'var(--sp-md)' }}>
                      All three fields are required — <strong>name, guardian name and
                      guardian contact</strong>. These are how this child will be matched
                      in every future year, when their class is promoted: roll numbers
                      are reassigned each year and cannot identify anybody. Getting the
                      contact right now is the difference between a clean promotion
                      review and a duplicate record.
                    </div>

                    <div className="form-grid-2">
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label" htmlFor="cm-new-name">Full Name *</label>
                        <input
                          id="cm-new-name"
                          className="form-input"
                          value={newStudent.name}
                          onChange={(e) => setNewStudent((s) => ({ ...s, name: e.target.value }))}
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label" htmlFor="cm-new-roll">Roll No. (that year)</label>
                        <input
                          id="cm-new-roll"
                          className="form-input"
                          value={newStudent.rollNumber}
                          onChange={(e) => setNewStudent((s) => ({ ...s, rollNumber: e.target.value }))}
                        />
                        <span className="form-help">Optional. This is the roll number they held in {selectedYear?.label || 'that year'} only.</span>
                      </div>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label" htmlFor="cm-new-parent">Guardian Name *</label>
                        <input
                          id="cm-new-parent"
                          className="form-input"
                          value={newStudent.parentName}
                          onChange={(e) => setNewStudent((s) => ({ ...s, parentName: e.target.value }))}
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label" htmlFor="cm-new-contact">Guardian Contact *</label>
                        <PhoneInput
                          id="cm-new-contact"
                          value={newStudent.guardianContact}
                          onChange={(v) => setNewStudent((s) => ({ ...s, guardianContact: v }))}
                        />
                      </div>
                    </div>

                    <div className="mk-actions" style={{ marginTop: 'var(--sp-md)' }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={newStudentMissing}
                        onClick={() => {
                          setSubject({
                            name: newStudent.name.trim(),
                            parentName: newStudent.parentName.trim(),
                            guardianContact: fieldToContact(newStudent.guardianContact),
                          });
                          setCreating(false);
                        }}
                        title={newStudentMissing ? 'Name, guardian name and a 10-digit contact are all required' : undefined}
                      >
                        Continue with this child
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={resetSubject}>
                        <X size={15} /> Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 2: the record ─────────────────────────────────────── */}
          {subject && (
            <div className="section">
              <div className="section-title">
                <Plus size={14} /> 2. Record {selectedYear?.label || 'this year'} for {subject.name}
              </div>

              <div className="att-note ok" style={{ marginBottom: 'var(--sp-md)' }}>
                <strong>{subject.name}</strong>
                {' · '}
                {subject.parentName || 'guardian not on file'}
                {' · '}
                {subject.guardianContact || 'contact not on file'}
                {subject.studentId
                  ? ' — attaching to the record already on file'
                  : ' — a new historical record'}
                {existingRecord && (
                  <> — already recorded in {existingRecord.classLabel}{existingRecord.rollNumber ? `, roll ${existingRecord.rollNumber}` : ''}; saving will correct that entry</>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ marginTop: 8, marginLeft: 0 }}
                  onClick={resetSubject}
                  disabled={saving}
                >
                  <X size={13} /> Change student
                </button>
              </div>

              {loadingExisting && <div className="loading-center"><div className="spinner" /></div>}

              {!loadingExisting && (
                <>
                  {/* Roll number for a CHILD already on file — separate from the
                      new-child form, because it updates the enrollment row for this
                      year only and never the student's current one. */}
                  {subject.studentId && (
                    <div className="card" style={{ marginBottom: 'var(--sp-lg)' }}>
                      <div className="form-group" style={{ marginBottom: 0, maxWidth: 220 }}>
                        <label className="form-label" htmlFor="cm-existing-roll">Roll No. for {selectedYear?.label}</label>
                        <input
                          id="cm-existing-roll"
                          className="form-input"
                          value={subject.rollNumber ?? ''}
                          onChange={(e) => setSubject((s) => ({ ...s, rollNumber: e.target.value }))}
                        />
                        <span className="form-help">
                          {existingRecord?.rollNumber
                            ? `Currently ${existingRecord.rollNumber} for that year.`
                            : 'No roll number was recorded for that year.'}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="card" style={{ marginBottom: 'var(--sp-lg)' }}>
                    <div className="section-title"><CalendarDays size={14} /> Attendance Summary — {selectedYear?.label}</div>
                    <div className="form-grid-3">
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label" htmlFor="cm-att-working">Working Days</label>
                        <input
                          id="cm-att-working"
                          className="form-input"
                          type="number"
                          min="0"
                          value={attendance.workingDays}
                          onChange={(e) => setAttendance((a) => ({ ...a, workingDays: e.target.value }))}
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label" htmlFor="cm-att-present">Days Present</label>
                        <input
                          id="cm-att-present"
                          className="form-input"
                          type="number"
                          min="0"
                          value={attendance.daysPresent}
                          onChange={(e) => setAttendance((a) => ({ ...a, daysPresent: e.target.value }))}
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label" htmlFor="cm-att-absent">Days Absent</label>
                        <input
                          id="cm-att-absent"
                          className={`form-input${attError ? ' mk-input--bad' : ''}`}
                          type="number"
                          min="0"
                          value={attendance.daysAbsent}
                          onChange={(e) => setAttendance((a) => ({ ...a, daysAbsent: e.target.value }))}
                        />
                      </div>
                    </div>
                    <div className="info-note" style={{ marginTop: 'var(--sp-md)' }}>
                      Yearly totals, taken from the register — not a day-by-day calendar,
                      because a record entered after the year has no individual days to
                      list. Leave all three blank if the register records no attendance.
                    </div>
                    {attError && <div className="login-error">{attError}</div>}
                  </div>

                  <div className="card">
                    <div className="section-title"><ClipboardList size={14} /> Exam Results — {selectedYear?.label}</div>
                    {marks.map((r, i) => (
                      <div key={i} className="form-grid-3" style={{ marginBottom: 'var(--sp-md)' }}>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          {i === 0 && <label className="form-label" htmlFor={`cm-exam-${i}`}>Exam Name</label>}
                          <input
                            id={`cm-exam-${i}`}
                            className="form-input"
                            value={r.examName}
                            onChange={(e) => setMark(i, 'examName')(e.target.value)}
                            placeholder="Unit Test 1"
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          {i === 0 && <label className="form-label" htmlFor={`cm-subj-${i}`}>Subject</label>}
                          <input
                            id={`cm-subj-${i}`}
                            className="form-input"
                            value={r.subject}
                            onChange={(e) => setMark(i, 'subject')(e.target.value)}
                            placeholder="Mathematics"
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          {i === 0 && (
                            <div className="flex items-center gap-sm" style={{ justifyContent: 'space-between' }}>
                              <label className="form-label" htmlFor={`cm-max-${i}`}>Max / Obtained</label>
                              {marks.length > 1 && (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => removeMarkRow(i)}
                                  aria-label={`Remove result row ${i + 1}`}
                                >
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </div>
                          )}
                          <div className="flex gap-sm">
                            <input
                              id={`cm-max-${i}`}
                              className="form-input"
                              type="number"
                              min="1"
                              value={r.maxMarks}
                              onChange={(e) => setMark(i, 'maxMarks')(e.target.value)}
                              placeholder="Max"
                              aria-label={`Maximum marks for result row ${i + 1}`}
                            />
                            <input
                              className={`form-input${markErrors[i] ? ' mk-input--bad' : ''}`}
                              type="number"
                              min="0"
                              value={r.obtained}
                              onChange={(e) => setMark(i, 'obtained')(e.target.value)}
                              placeholder="Obtained"
                              aria-label={`Obtained marks for result row ${i + 1}`}
                            />
                          </div>
                        </div>
                        {i > 0 && (
                          <div style={{ gridColumn: '1 / -1', textAlign: 'right', marginTop: -8 }}>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => removeMarkRow(i)}
                            >
                              <Trash2 size={13} /> Remove this result
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    {markErrors.map((e, i) => (e ? <div key={i} className="mk-row-error">Row {i + 1}: {e}</div> : null))}

                    <div className="mk-actions" style={{ marginTop: 'var(--sp-md)' }}>
                      <button type="button" className="btn btn-secondary" onClick={addMarkRow}>
                        <Plus size={15} /> Add another result
                      </button>
                    </div>
                  </div>

                  <div className="mk-actions" style={{ marginTop: 'var(--sp-lg)' }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={guard(save)}
                      disabled={!canSave}
                      title={canSave ? undefined : 'Complete the highlighted fields first'}
                    >
                      <Save size={16} /> {saving ? 'Saving…' : 'Save Historical Record'}
                    </button>
                    <span className="text-sm text-muted">
                      Saved against {selectedYear?.label} and the class chosen above,
                      marked as a historical record so it is never confused with live data.
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}