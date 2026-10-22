import { useCallback, useEffect, useState } from 'react';
import { Eye, History } from 'lucide-react';
import StudentProfileModal from './StudentProfileModal';
import api from '../services/api';
import toast from '../services/toast';

/**
 * Class History — "what did this class look like in that year?".
 *
 * ## The two selectors answer two different questions
 *
 * The year selector lists every academic year in the database. The class selector
 * then lists **the classes that existed in THAT year**, which is not today's class
 * list: a section that ran in 2023-24 and has since been merged away must still be
 * selectable for 2023-24, and a section created this year must not appear for
 * 2023-24. The server decides that from the enrollment table, so a year the school
 * never ran shows an honest empty list instead of a class that was never there.
 *
 * ## The roster comes from per-year enrollment rows
 *
 * The rows are the child's record AS OF THAT YEAR — the class and roll number they
 * actually held then, not their current ones. That distinction is the whole reason
 * this tab exists: after a promotion, "Class 9B in 2024-25" is only recoverable
 * from the enrollment row, because the student's current class says something else.
 *
 * @param {Array} props.years every academic year, newest first (from the page)
 */
export default function ClassManagementHistory({ years }) {
  const [yearId, setYearId] = useState('');
  const [classId, setClassId] = useState('');
  const [classes, setClasses] = useState([]);
  const [roster, setRoster] = useState(null);
  const [loadingClasses, setLoadingClasses] = useState(false);
  const [loadingRoster, setLoadingRoster] = useState(false);
  const [openStudent, setOpenStudent] = useState(null);

  /* Default to the newest year that actually has a record. Starting on the current
     year would open onto an empty roster for a school that migrated mid-year, with
     no hint that older years exist — so the selector, not the guess, is what the
     admin should change first. */
  useEffect(() => {
    if (!yearId && years.length) setYearId(years[0].id);
  }, [years, yearId]);

  /* Changing the year invalidates the class, so it is cleared rather than kept:
     class ids are stable, which makes a stale id look valid while pointing at a
     class that never ran in the newly chosen year. */
  useEffect(() => {
    if (!yearId) { setClasses([]); setClassId(''); setRoster(null); return; }
    let alive = true;
    setLoadingClasses(true);
    setClassId('');
    setRoster(null);
    api.get(`/admin/class-management/years/${yearId}/classes`)
      .then((res) => { if (alive) setClasses(res.data.data || []); })
      .catch((err) => {
        if (!alive) return;
        setClasses([]);
        toast.error(err.response?.data?.message || 'Could not load the classes for that year');
      })
      .finally(() => { if (alive) setLoadingClasses(false); });
    return () => { alive = false; };
  }, [yearId]);

  const loadRoster = useCallback(async (id) => {
    if (!yearId || !id) { setRoster(null); return; }
    setLoadingRoster(true);
    try {
      const res = await api.get(
        `/admin/class-management/years/${yearId}/classes/${id}/roster`,
      );
      setRoster(res.data.data || []);
    } catch (err) {
      setRoster(null);
      toast.error(err.response?.data?.message || 'Could not load that class roster');
    } finally {
      setLoadingRoster(false);
    }
  }, [yearId]);

  useEffect(() => { loadRoster(classId); }, [classId, loadRoster]);

  /* `existed` is the server's own answer to "did this class actually run that
     year" — derived from the enrollment table, so a section invented this year
     cannot appear in a 2023-24 selector. Only those get a roster link; the rest
     stay listed (the admin can see the section) but cannot be opened, because
     opening one would promise a list of students that never existed. */
  const usedCount = (c) => c.historyCount ?? 0;
  const selectedYear = years.find((y) => y.id === yearId);

  return (
    <>
      <div className="card" style={{ marginBottom: 'var(--sp-lg)' }}>
        <div className="form-grid-2">
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="cm-history-year">Academic Year</label>
            <select
              id="cm-history-year"
              className="form-input"
              value={yearId}
              onChange={(e) => setYearId(e.target.value)}
            >
              {years.length === 0 && <option value="">No academic years on file</option>}
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}{y.isCurrent ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="cm-history-class">Class (as it was that year)</label>
            <select
              id="cm-history-class"
              className="form-input"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              disabled={!yearId || loadingClasses}
            >
              <option value="">
                {loadingClasses
                  ? 'Loading classes…'
                  : yearId ? 'Choose a class' : 'Choose a year first'}
              </option>
              {classes.map((c) => (
                <option key={c.id} value={c.id} disabled={!c.existed}>
                  {c.label}
                  {c.existed
                    ? ` — ${usedCount(c)} student${usedCount(c) === 1 ? '' : 's'}`
                    : ' — did not run that year'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {classes.length > 0 && (
          <div className="info-note" style={{ marginTop: 'var(--sp-md)' }}>
            These are the classes on file for {selectedYear?.label || 'that year'} — not
            today&apos;s class list. A section that did not run that year cannot be
            opened.
          </div>
        )}
      </div>

      {loadingRoster && <div className="loading-center"><div className="spinner" /></div>}

      {!loadingRoster && roster && roster.length === 0 && (
        <div className="empty-state">
          <History size={22} />
          No student was recorded in this class for {selectedYear?.label || 'that year'}.
          <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
            Pick another class, or use <strong>Enter Past Data</strong> to record the
            year the school never entered live.
          </div>
        </div>
      )}

      {!loadingRoster && roster && roster.length > 0 && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Student</th>
                <th style={{ width: 90 }}>Roll No.</th>
                <th>Where they went</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {roster.map((r) => (
                <tr key={r.enrollmentId}>
                  <td>
                    <div className="mk-saved-name">{r.name}</div>
                    {!r.isCurrentlyHere && (
                      <span className="text-sm text-muted">
                        {r.status === 'promoted' ? 'left this class' : r.status === 'passed_out' ? 'passed out of school' : r.status === 'left_school' ? 'left the school' : 'not currently in this class'}
                      </span>
                    )}
                  </td>
                  <td>{r.rollNumber ?? '—'}</td>
                  <td>
                    {r.isCurrentlyHere ? (
                      <span className="text-sm text-muted">Still in this class</span>
                    ) : r.promotedFromLabel ? (
                      <span className="text-sm text-muted">
                        Promoted from {r.promotedFromLabel}
                        {r.currentClassLabel ? ` — now in ${r.currentClassLabel}` : ' — no current class'}
                      </span>
                    ) : r.currentClassLabel ? (
                      <span className="text-sm text-muted">Now in {r.currentClassLabel}</span>
                    ) : (
                      <span className="text-sm text-muted">
                        {r.status === 'passed_out' ? 'Passed out of school' : 'No current class'}
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setOpenStudent({ id: r.studentId, name: r.name })}
                    >
                      <Eye size={13} /> View Profile
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loadingRoster && !roster && !classId && (
        <div className="empty-state">
          Choose an academic year and a class to see who was in it.
        </div>
      )}

      {/* The profile modal, scoped to the year that was chosen — so it answers "what
          did this child's record say THEN", not "what does it say now". */}
      {openStudent && yearId && (
        <StudentProfileModal
          student={openStudent}
          academicYearId={yearId}
          onClose={() => setOpenStudent(null)}
        />
      )}
    </>
  );
}