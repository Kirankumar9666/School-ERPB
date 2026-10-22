import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Trash, Upload, FileSpreadsheet, Award, Users, ClipboardList,
  History, Save, ShieldCheck, X,
} from 'lucide-react';
import Modal from '../../components/Modal';
import ClassSelect from '../../components/ClassSelect';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import { classChoices } from '../../utils/classes';
import { shortDate, shortStamp } from '../../utils/date';
import { parseObtained, MARKS_MAX } from '../../utils/marks';
import toast from '../../services/toast';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';

/**
 * Bulk-upload columns — long/tidy format (one row per student per subject).
 * Must match the backend's MARKS_BULK_COLUMNS exactly (header row required).
 * Class/Section are deliberately absent: the class is chosen once with the
 * page's Select Class dropdown and posted with the file, so the spreadsheet
 * can never contradict the page (or target another class).
 */
const BULK_COLUMNS = [
  'RollNumber', 'StudentName', 'ExamName', 'ExamDate',
  'Subject', 'MaxMarks', 'ObtainedMarks',
];

/**
 * A blank subject row. Subjects are admin-defined per exam — nothing here is a
 * fixed subject list, and the admin can add/remove/rename rows freely.
 */
const subjectRow = (subject = '', maxMarks = 100, obtained = '') => ({ subject, maxMarks, obtained });

/** Turn a { row_2: { RollNumber: 'msg' } } / { file: 'msg' } error map into readable lines */
const errorLines = (errors) =>
  Object.entries(errors || {}).map(([field, detail]) => {
    const label = field === 'file' ? 'File' : field.startsWith('row_') ? `Row ${field.slice(4)}` : field;
    const text = typeof detail === 'string'
      ? detail
      : Object.entries(detail || {}).map(([col, msg]) => `${col}: ${msg}`).join(' · ');
    return `${label} — ${text}`;
  });

/**
 * Who recorded, and who last changed, a student's mark rows.
 *
 * Reads the attribution columns the marks carry: a row records the account that
 * first entered it, and a later correction records a separate "last changed by"
 * without erasing the original author. Rows saved before attribution existed
 * carry no author and read as "—" rather than being attributed to whoever is
 * looking. Teacher-entered marks land here through exactly the same tables, so
 * this is the admin's view of what the Employee Portal's Marks Entry wrote.
 */
const attributionOf = (exams) => {
  const rows = exams.flatMap((ex) => ex.subjects || []);
  const enteredBy = [...new Set(rows.map((r) => r.enteredBy).filter(Boolean))];
  const updatedBy = [...new Set(rows.map((r) => r.updatedBy).filter(Boolean))];
  const latest = rows.map((r) => r.updatedAt).filter(Boolean).sort().pop() || null;
  return { enteredBy, updatedBy, latest };
};

/**
 * Admin Marks — three ways in, one store.
 *
 *  1. "Enter Marks for One Student"  — the original form, for a single student
 *     across several subjects at once.
 *  2. The ALREADY SAVED card grid    — the same card pattern the Employee Portal
 *     uses, one card per (exam, subject) BATCH, computed live from this class's
 *     own marks. Clicking a card opens that batch's whole-class roster, prefilled,
 *     to correct it.
 *  3. "Results by Student"           — a per-student report of totals and averages.
 *
 * The card grid and the table are NOT two histories of the same thing and are not
 * redundant: they read along different axes. A batch is what is saved, counted and
 * attributed, so only the grid can show a batch's own entered/avg/top. A student
 * is what a report is about, so only the table can show one student's totals
 * across every exam. The grid is the way IN (click to edit); the table is the way
 * to READ a student. Both are titled for the axis they use.
 *
 * ── Why one grid and not one per subject ─────────────────────────────────────
 * `Exam` is `@@unique([classId, name])` and has no subject column: an exam is a
 * per-class object that HOLDS marks in one or more subjects. So a grid per subject
 * would print the same exam's name and date in several places and imply a
 * per-subject exam the schema does not have. A batch is still (exam, subject) —
 * that is the row's uniqueness and the unit a card must open — so the subject
 * rides on the card instead, and a chip row filters the grid when a class has more
 * than one subject. The filter is client-side on purpose: it narrows a list of a
 * few dozen cards this page already holds, so it costs no round trip.
 *
 * ── No time restriction here ────────────────────────────────────────────────
 * The Employee Portal's 48-hour edit window is the TEACHER's. The admin is never
 * inside it, so this page never shows a countdown, never greys an input out and
 * never asks the server permission: a card is openable and correctable whenever
 * it is opened. `POST /admin/marks/class` saves with `writer: 'admin'`, which is
 * the server's own statement of that. It still records the admin in
 * `updatedBy` / `updatedAt`, so a batch a teacher entered reads "last changed by
 * admin" once it has been corrected here, and it does NOT touch the teacher's
 * clock — correcting a batch does not hand the teacher 48 fresh hours to undo it.
 */
export default function AdminMarks() {
  const [students, setStudents] = useState([]);
  const [classes, setClasses] = useState([]); // live class list (options API)
  const [classKey, setClassKey] = useState('');
  const [marks, setMarks] = useState({});
  /* `error: loadError` because the upload form below owns its own `error` state —
     a failed page load and a rejected upload are different things on this page. */
  const { loading, setLoading, error: loadError, reloadKey, retry, fail } = useLoadState();
  const [studentId, setStudentId] = useState('');
  const [examName, setExamName] = useState('');
  const [date, setDate] = useState('');
  const [rows, setRows] = useState([subjectRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /* ── The batch history: cards, the opened batch, and its editor ── */
  const [view, setView] = useState(null);       // GET /admin/marks/class payload
  const [viewLoading, setViewLoading] = useState(false);
  const [subjectFilter, setSubjectFilter] = useState(''); // '' = every subject
  const [open, setOpen] = useState(null);       // { examName, subject } being corrected
  const [entries, setEntries] = useState({});   // studentId → typed text
  const [batchMax, setBatchMax] = useState(''); // Max Marks for the opened batch
  const [gridSaving, setGridSaving] = useState(false);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErrors, setBulkErrors] = useState([]);
  const [downloading, setDownloading] = useState(false);

  const loadStudents = () => api.get('/admin/students').then((r) => setStudents(r.data.data));

  const loadMarks = () => api.get('/admin/marks').then((r) => setMarks(r.data.data || {}));

  /**
   * Load the class's batch history, and — when `target` names one — open that
   * batch's roster pre-filled. One request for both, because the server computes
   * the cards and the opened batch from the same rows; fetching them separately
   * would risk the grid and the grid being edited from disagreeing.
   */
  const loadView = useCallback(async (classId, target = null) => {
    if (!classId) {
      setView(null);
      return;
    }
    setViewLoading(true);
    try {
      const params = new URLSearchParams({ classId });
      if (target) {
        params.set('examName', target.examName);
        params.set('subject', target.subject);
      }
      const r = await api.get(`/admin/marks/class?${params.toString()}`);
      const data = r.data.data;
      setView(data);
      // Prefill from what is STORED, not from what was typed before: `null` is a
      // student with no mark, and it must come back as an empty cell — never a
      // zero. Values are held as text so a partially-typed "1" is not rewritten
      // under the cursor on every keystroke.
      setEntries(Object.fromEntries(
        (data.roster || []).map((s) => [s.studentId, s.obtained === null ? '' : String(s.obtained)]),
      ));
      setBatchMax(data.batch?.maxMarks ? String(data.batch.maxMarks) : '');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load saved marks.');
    } finally {
      setViewLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([
      loadStudents(),
      loadMarks(),
      // Same shared class list the Timetable/Syllabus/Attendance/Documents
      // pages use — never a local copy.
      loadOptions().then((o) => setClasses(o.classes)),
    ]).catch(fail).finally(() => setLoading(false));
  }, [reloadKey, fail, setLoading]);

  // A new class means a new history, and any batch open belonged to the old one —
  // so the editor closes rather than silently following the class selector.
  useEffect(() => {
    setOpen(null);
    setSubjectFilter('');
    loadView(classKey);
  }, [classKey, loadView]);

  /* A student's REAL class id, from the row. This used to be rebuilt as
     `cls-${class}${section}`, which is right while a level name is a number and
     silently produces 'cls--2A' for Nursery — a class id that does not exist, so
     the dropdown would show the class but selecting it would load no roster. */
  const choices = classChoices(students.map((s) => s.classId).filter(Boolean), classes);

  // Only the selected class's students — the stat cards, the entry form and
  // bulk upload are all scoped to this class.
  const classStudents = classKey ? students.filter((s) => classIdOfStudent(s) === classKey) : [];
  const activeLabel = choices.find((c) => c.id === classKey)?.label || '';

  // Keep the selected student inside the chosen class: switching classes
  // clears a now-out-of-class selection and pre-selects the class's first
  // student, so "Upload Marks" can never post for a student of another class.
  useEffect(() => {
    setStudentId((current) => {
      if (classStudents.some((s) => s.id === current)) return current;
      return classStudents[0]?.id || '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classKey, students]);

  /* ── The opened batch, derived ─────────────────────────────────────────────
     Identical validation to the Employee Portal's roster, through the same
     `parseObtained` — the two grids edit the same kind of number, so they must
     draw the same line. Unlike the teacher's, none of it can go read-only: there
     is no window here to close. */

  /** Max Marks of the opened batch, or NaN while it is not a usable number. */
  const maxValue = /^\d+$/.test(batchMax.trim()) ? Number(batchMax) : NaN;
  const maxError = !batchMax.trim()
    ? 'Max Marks is required'
    : Number.isNaN(maxValue) || maxValue < 1
      ? 'Max Marks must be a whole number of at least 1'
      : maxValue > MARKS_MAX
        ? `Max Marks cannot be more than ${MARKS_MAX}`
        : null;

  // Both are memoized on `view` so their identity only changes when a refetch
  // actually replaced them — otherwise the `rowState` memo below would
  // re-evaluate on every render and the `useMemo` would be pointless.
  const roster = useMemo(() => view?.roster || [], [view]);
  const rowState = useMemo(
    () => Object.fromEntries(roster.map((r) => [r.studentId, parseObtained(entries[r.studentId], maxValue)])),
    [roster, entries, maxValue],
  );
  const enteredCount = roster.filter((r) => rowState[r.studentId]?.state === 'ok').length;
  const invalidRows = roster.filter((r) => rowState[r.studentId]?.state === 'invalid');
  const canSaveBatch = enteredCount > 0 && invalidRows.length === 0 && !maxError && !gridSaving;

  /** The cards, narrowed by the subject chips. Client-side on purpose. */
  const visibleBatches = useMemo(() => {
    const all = view?.batches || [];
    return subjectFilter ? all.filter((b) => b.subject === subjectFilter) : all;
  }, [view, subjectFilter]);

  const setRow = (i, key) => (e) => {
    const next = [...rows];
    next[i] = { ...next[i], [key]: e.target.value };
    setRows(next);
  };

  const addRow = () => setRows([...rows, subjectRow()]);
  const removeRow = (i) => setRows(rows.filter((_, idx) => idx !== i));

  /* ── Opening and correcting one saved batch ── */

  /** Click a card: open that batch's whole-class roster, pre-filled from the server. */
  const openBatch = (batch) => {
    setOpen({ examName: batch.examName, subject: batch.subject });
    loadView(classKey, { examName: batch.examName, subject: batch.subject });
  };

  /** Close the editor. The card grid is already loaded, so nothing is refetched. */
  const closeBatch = () => {
    setOpen(null);
    setEntries({});
    setBatchMax('');
  };

  const setEntry = (studentId, value) => setEntries((prev) => ({ ...prev, [studentId]: value }));

  /**
   * Save the opened batch. Only cells holding a valid number are sent, and a
   * blank cell is not an error and not a zero:
   *
   *   - blank where there was no mark → no row is created. An absent student did
   *     not score zero, and writing 0 would record a mark nobody entered.
   *   - blank where there WAS a mark  → that row is left exactly as it is. This
   *     is an edit, not a rebuild: the marks you name are the marks that change.
   *
   * So a student who already has a mark keeps it until you replace it with
   * another number, which is what makes opening a card and hitting Save without
   * touching anything a safe no-op rather than a way to wipe a class.
   */
  const saveBatch = async () => {
    const payload = [];
    roster.forEach((s) => {
      const state = rowState[s.studentId];
      if (state?.state === 'ok') payload.push({ studentId: s.studentId, obtained: state.value });
    });
    if (payload.length === 0) {
      toast.error('Enter at least one mark first.');
      return;
    }
    setGridSaving(true);
    try {
      const r = await api.post('/admin/marks/class', {
        classId: classKey,
        examName: open.examName,
        subject: open.subject,
        date: view?.batch?.date || undefined,
        maxMarks: maxValue,
        entries: payload,
      });
      toast.success(r.data.message || 'Marks saved.');
      // Refetch the opened batch so the cells show what was actually STORED, not
      // what was typed — and the cards below, so their avg/top/count move with it.
      await loadView(classKey, open);
      await loadMarks();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save these marks.');
    } finally {
      setGridSaving(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const clean = rows
      .filter((r) => r.subject.trim() && r.maxMarks)
      .map((r) => ({ subject: r.subject.trim(), maxMarks: Number(r.maxMarks), obtained: Number(r.obtained || 0) }));

    if (!studentId || !examName.trim() || clean.length === 0) {
      toast.error('Select a student, enter an exam name and at least one subject.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.post('/admin/marks', { studentId, examName: examName.trim(), date: date || undefined, subjects: clean });
      toast.success('Marks uploaded!');
      setExamName('');
      setDate('');
      setRows([subjectRow()]);
      await loadMarks();
      // A per-student save is a batch save too, so the cards below have to move
      // with it — and if one of them was open, its roster re-reads what landed.
      await loadView(classKey, open);
    } catch (err) {
      const lines = errorLines(err.response?.data?.errors);
      const message = err.response?.data?.message || 'Could not upload marks.';
      setError(lines.length ? `${message}: ${lines.join(' ')}` : message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  /** Download the server-generated .xlsx template (built by the same parser that reads it back) */
  const downloadTemplate = async () => {
    setDownloading(true);
    try {
      const res = await api.get('/admin/marks/bulk-template', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'marks_bulk_upload_template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not download the template.');
    } finally {
      setDownloading(false);
    }
  };

  const handleBulk = async (file) => {
    setBulkErrors([]);
    if (!file) {
      setBulkErrors(['Choose a .csv or .xlsx file first.']);
      return;
    }
    setBulkBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // The class comes from the page's Select Class dropdown — never from the
      // file (the template has no Class/Section columns).
      fd.append('classId', classKey);
      const res = await api.post('/admin/marks/bulk', fd);
      toast.success(res.data.message || 'Marks saved.');
      setBulkOpen(false);
      await loadMarks();
      // A bulk upload creates and corrects batches in bulk — the card grid is
      // derived from exactly those rows, so it has to be re-read, not patched.
      await loadView(classKey, open);
    } catch (err) {
      const lines = errorLines(err.response?.data?.errors);
      setBulkErrors(lines.length
        ? [err.response?.data?.message || 'Upload rejected.', ...lines]
        : [err.response?.data?.message || 'Bulk upload failed.']);
    } finally {
      setBulkBusy(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  /* A failed page load is not "no marks exist": the load error takes the page
     before any of the derived stats or empty states further down can render. */
  if (loadError) {
    return (
      <LoadErrorState
        title="Marks Entry"
        subtitle="Select a class to begin · upload, correct and review saved marks"
        detail={loadError}
        onRetry={retry}
        icon={ClipboardList}
      />
    );
  }

  /* ---- Everything below is derived from the marks actually stored, never hardcoded ---- */

  /** Per-student totals across every exam/subject row they have saved —
   * computed for the selected class only, never school-wide */
  const studentStats = classStudents
    .map((s) => {
      const exams = marks[s.id] || [];
      let obtained = 0;
      let max = 0;
      exams.forEach((ex) => ex.subjects.forEach((sub) => {
        obtained += Number(sub.obtained) || 0;
        max += Number(sub.maxMarks) || 0;
      }));
      return {
        student: s, exams, obtained, max, percent: max ? (obtained / max) * 100 : null, ...attributionOf(exams),
      };
    })
    .filter((row) => row.exams.length > 0);

  const totalEntities = studentStats.reduce(
    (n, row) => n + row.exams.reduce((m, ex) => m + ex.subjects.length, 0), 0,
  );
  const examCount = new Set(studentStats.flatMap((row) => row.exams.map((ex) => ex.examName))).size;
  const scored = studentStats.filter((row) => row.percent !== null);
  const averagePercent = scored.length
    ? scored.reduce((sum, row) => sum + row.percent, 0) / scored.length
    : null;
  const topRow = scored.length ? scored.reduce((best, row) => (row.percent > best.percent ? row : best)) : null;
  const readyRows = rows.filter((r) => r.subject.trim() && r.maxMarks);
  const statsReady = Boolean(classKey);

  const pct = (value) => (value === null || value === undefined ? '—' : `${value.toFixed(1)}%`);

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Marks Entry</div>
        <div className="page-subtitle">
          {statsReady ? activeLabel : 'Select a class to begin'} ·{' '}
          {totalEntities} saved mark row{totalEntities === 1 ? '' : 's'} · {examCount}{' '}
          exam{examCount === 1 ? '' : 's'} · {studentStats.length} student{studentStats.length === 1 ? '' : 's'} with results
        </div>
      </div>

      {/* Same shared class selector as Timetable / Syllabus / Attendance / Documents */}
      <ClassSelect
        id="marks-class"
        value={classKey}
        onChange={setClassKey}
        choices={choices}
        placeholder="Choose a class…"
        style={{ maxWidth: 280, marginBottom: 'var(--sp-lg)' }}
      />

      {!statsReady && (
        <div className="card" style={{ marginBottom: 'var(--sp-lg)' }}>
          <div className="text-muted">
            Choose a class above — the stats below, the entry form and Bulk Upload all work on the selected class only.
          </div>
        </div>
      )}

      {/* Derived live from the marks in the database — nothing here is hardcoded */}
      <div className="stat-grid" style={{ marginBottom: 'var(--sp-xl)' }}>
        <div className="stat-card">
          <div className="stat-icon stat-icon-primary"><ClipboardList size={22} /></div>
          <div><div className="stat-value">{statsReady ? totalEntities : '—'}</div><div className="stat-label">Mark Rows Saved</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-info"><FileSpreadsheet size={22} /></div>
          <div><div className="stat-value">{statsReady && averagePercent !== null ? pct(averagePercent) : '—'}</div><div className="stat-label">Average Score</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-success"><Award size={22} /></div>
          <div>
            <div className="stat-value">{statsReady && topRow ? pct(topRow.percent) : '—'}</div>
            <div className="stat-label">{statsReady && topRow ? `Top — ${topRow.student.name}` : 'Top Score'}</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-warning"><Users size={22} /></div>
          <div><div className="stat-value">{statsReady ? studentStats.length : '—'}</div><div className="stat-label">Students Assessed</div></div>
        </div>
      </div>
      <div className="section">
        <div className="section-title"><Upload size={14} /> Enter Marks for One Student</div>
        <div className="card">
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-lg)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--sp-md)' }}>
              <div className="form-group">
                <label className="form-label">Student *</label>
                <select
                  className="form-input"
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  disabled={!statsReady}
                >
                  {!statsReady ? (
                    <option value="">Select a class first…</option>
                  ) : (
                    classStudents.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}{s.rollNumber ? ` (${s.rollNumber})` : ''}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Exam Name *</label>
                <input
                  className="form-input"
                  value={examName}
                  onChange={(e) => setExamName(e.target.value)}
                  placeholder="e.g. Unit Test 2"
                  disabled={!statsReady}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Exam Date</label>
                <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} disabled={!statsReady} />
              </div>
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr><th>Subject</th><th>Max Marks</th><th>Obtained</th><th>{''}</th></tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          className="form-input"
                          value={r.subject}
                          onChange={setRow(i, 'subject')}
                          placeholder="Any subject name"
                          aria-label={`Subject for row ${i + 1}`}
                          disabled={!statsReady}
                        />
                      </td>
                      <td>
                        <input
                          className="form-input" type="number" min="1" value={r.maxMarks}
                          onChange={setRow(i, 'maxMarks')} aria-label={`Max marks for row ${i + 1}`}
                          disabled={!statsReady}
                        />
                      </td>
                      <td>
                        <input
                          className="form-input" type="number" min="0" value={r.obtained}
                          onChange={setRow(i, 'obtained')} aria-label={`Obtained marks for row ${i + 1}`}
                          disabled={!statsReady}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => removeRow(i)}
                          disabled={rows.length === 1 || !statsReady}
                          aria-label="Remove row"
                        >
                          <Trash size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
{error && <div className="login-error">{error}</div>}

            <div style={{ display: 'flex', gap: 'var(--sp-md)', alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={addRow} disabled={!statsReady}>
                <Plus size={16} /> Add Subject
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || !statsReady}>
                <Upload size={16} /> {saving ? 'Uploading...' : 'Upload Marks'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => { setBulkErrors([]); setBulkOpen(true); }}
                disabled={!statsReady}
                title={statsReady ? `Bulk upload marks for ${activeLabel}` : 'Select a class first'}
              >
                <FileSpreadsheet size={16} /> Bulk Upload
              </button>
              <span className="text-sm text-muted">
                {readyRows.length} subject{readyRows.length === 1 ? '' : 's'} ready · subjects are free text, added by you
              </span>
            </div>
          </form>
        </div>
      </div>

      {/* ── Correcting one saved batch ───────────────────────────────────────
          Appears only after a card below has been clicked, and it sits directly
          above that grid so the thing being edited and the list it came from stay
          in one glance. The note says the one thing that is true here and not on
          the Employee Portal: there is no countdown, because the admin is never
          inside the teacher's 2-day window. */}
      {statsReady && open && (
        <div className="section">
          <div className="section-title">
            <ClipboardList size={14} /> Correcting {view?.batch?.examName || open.examName} · {open.subject}
            <span className="mk-count">{enteredCount} of {roster.length} entered</span>
          </div>
          <div className="card" style={{ padding: 0 }}>
            {viewLoading ? (
              <div className="loading-center"><div className="spinner" /></div>
            ) : !view ? (
              /* Not the same as an empty class: a failed load has no roster at
                 all, and saying "no students" would blame the class for it. */
              <div className="text-muted" style={{ padding: 'var(--sp-lg)' }}>
                Could not load this exam's marks. Close and click the card again.
              </div>
            ) : roster.length === 0 ? (
              <div className="text-muted" style={{ padding: 'var(--sp-lg)' }}>
                No students in this class yet.
              </div>
            ) : (
              <div className="table-wrapper mk-roster" style={{ border: 'none', borderRadius: 0, boxShadow: 'none' }}>
                <table>
                  <thead>
                    <tr><th>Roll No</th><th>Name</th><th>Obtained</th></tr>
                  </thead>
                  <tbody>
                    {roster.map((s) => {
                      const state = rowState[s.studentId] || { state: 'empty' };
                      return (
                        <tr key={s.studentId}>
                          <td>{s.rollNumber || '—'}</td>
                          <td>{s.name}</td>
                          <td>
                            <div className="mk-cell">
                              <input
                                className={`form-input mk-input${state.state === 'invalid' ? ' mk-input--bad' : ''}`}
                                type="number"
                                min="0"
                                max={Number.isNaN(maxValue) ? undefined : maxValue}
                                value={entries[s.studentId] ?? ''}
                                onChange={(e) => setEntry(s.studentId, e.target.value)}
                                aria-label={`Obtained marks for ${s.name}`}
                                disabled={gridSaving}
                              />
                              {state.state === 'invalid' && (
                                <span className="mk-row-error">{state.reason}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {invalidRows.length > 0 && (
            <div className="login-error" style={{ marginTop: 'var(--sp-md)' }}>
              Fix {invalidRows.length} invalid mark{invalidRows.length === 1 ? '' : 's'}
              {maxValue >= 1 ? ` — obtained cannot be above ${maxValue} or below 0` : ''}. Nothing can be
              saved until they are corrected.
            </div>
          )}

          <div className="mk-actions" style={{ marginTop: 'var(--sp-md)' }}>
            <div className="form-group" style={{ marginBottom: 0, maxWidth: 180 }}>
              <label className="form-label" htmlFor="mk-batch-max">Max Marks *</label>
              <input
                id="mk-batch-max"
                className={`form-input${maxError ? ' mk-input--bad' : ''}`}
                type="number"
                min="1"
                max={MARKS_MAX}
                value={batchMax}
                onChange={(e) => setBatchMax(e.target.value)}
                disabled={gridSaving}
              />
              {maxError && <span className="mk-row-error">{maxError}</span>}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={saveBatch}
              disabled={!canSaveBatch}
              title={canSaveBatch ? undefined : 'Fix the highlighted marks first'}
            >
              <Save size={16} /> {gridSaving ? 'Saving…' : 'Save Marks'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={closeBatch} disabled={gridSaving}>
              <X size={16} /> Close
            </button>
            <span className="text-sm text-muted">
              <ShieldCheck size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              You can change these at any time — the 2-day window is your teachers', not yours.
              Saving records you as the last change. The whole class saves at once, and a
              blank cell is left as it is — never stored as a zero, and never used to
              wipe a mark that is already there.
            </span>
          </div>
        </div>
      )}

      {/* ── The class's saved exams, one card per (exam, subject) batch ── */}
      <div className="section">
        <div className="section-title">
          <History size={14} /> Already saved · {activeLabel || 'no class selected'}
          {view && <span className="mk-count">{visibleBatches.length} of {view.batches.length} batch{view.batches.length === 1 ? '' : 'es'}</span>}
        </div>
        <div className="card">
          {!statsReady ? (
            <div className="text-muted">Choose a class above to see its saved exams.</div>
          ) : !view ? (
            /* Explicit, because a failed load leaves `view` null and is not the
               same thing as "this class has no marks" — the branch chain below
               must never reach the grid with nothing loaded, or a dead API would
               render as a crash instead of as a message. */
            viewLoading
              ? <div className="loading-center"><div className="spinner" /></div>
              : <div className="text-muted">Could not load saved marks for {activeLabel}. Try selecting the class again.</div>
          ) : view.batches.length === 0 ? (
            <div className="text-muted">
              Nothing saved yet for {activeLabel}. Enter marks above, or Bulk Upload a
              spreadsheet — anything saved here appears as a card and can be re-opened to
              correct, at any time.
            </div>
          ) : (
            <>
              {/* One exam is one exam for the whole class, so the grid covers every
                  subject at once and the subject rides on each card. The chips only
                  appear when there is a choice to make. */}
              {view.subjects.length > 1 && (
                <div className="mk-chips" style={{ marginBottom: 'var(--sp-md)' }}>
                  {[{ label: 'All subjects', value: '' }, ...view.subjects.map((s) => ({ label: s, value: s }))]
                    .map((c) => (
                      <button
                        key={c.value || '__all'}
                        type="button"
                        className={`mk-chip${subjectFilter === c.value ? ' active' : ''}`}
                        aria-pressed={subjectFilter === c.value}
                        onClick={() => setSubjectFilter(c.value)}
                      >
                        {c.label}
                      </button>
                    ))}
                </div>
              )}

              <div className="mk-saved-list">
                {visibleBatches.map((b) => {
                  const key = `${b.examId}::${b.subject}`;
                  const isOpen = Boolean(open) && key === `${view.batch?.examId}::${open?.subject}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`mk-saved-item${isOpen ? ' mk-saved-item--open' : ''}`}
                      aria-pressed={isOpen}
                      onClick={() => openBatch(b)}
                      title={`Open ${b.examName} · ${b.subject} to correct it — you can edit this at any time`}
                    >
                      <div className="mk-saved-name">{b.examName}</div>
                      <div className="text-sm text-muted">{b.date}</div>
                      <div className="mk-saved-stats">
                        <span className="badge badge-primary">{b.subject}</span>
                        <span className="badge badge-muted">{b.saved} entered</span>
                        {b.average !== null && <span className="badge badge-info">avg {b.average}</span>}
                        {b.top !== null && <span className="badge badge-success">top {b.top}</span>}
                        {/* Provenance, not a countdown. There is deliberately no
                            "Locked" badge here: the admin is never locked, and
                            showing one would be a lie about what this page can do.
                            The date is day-precision on purpose — "how stale is the
                            teacher's data" is the question, and a clock time on a
                            210px card is not worth the extra line. */}
                        {b.updatedBy
                          ? <span className="badge badge-warning">last changed by {b.updatedBy}</span>
                          : b.enteredBy && <span className="badge badge-info">entered by {b.enteredBy}</span>}
                        {b.savedAt && <span className="badge badge-muted">teacher saved {shortDate(b.savedAt)}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <ClipboardList size={14} /> Results by Student · {activeLabel || 'no class selected'}
        </div>
        <div className="text-sm text-muted" style={{ marginBottom: 'var(--sp-sm)' }}>
          Every student's totals and average across all their exams — a read-only report.
          To correct a mark, open it from the exam cards above.
        </div>
        {studentStats.length === 0 ? (
          <div className="card">
            <div className="text-muted">
              No marks saved yet. Enter them for one student above, or use Bulk Upload for a whole class.
            </div>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Student</th><th>Class</th><th>Roll No</th><th>Exams</th>
                  <th>Saved Rows</th><th>Obtained</th><th>Max</th><th>Average</th>
                  <th>Entered By</th><th>Last Changed</th>
                </tr>
              </thead>
              <tbody>
                {studentStats.map((row) => (
                  <tr key={row.student.id}>
                    <td><b>{row.student.name}</b></td>
                    <td>{row.student.classLabel || `${row.student.class}-${row.student.section}`}</td>
                    <td>{row.student.rollNumber || '—'}</td>
                    <td>{row.exams.map((ex) => ex.examName).join(', ')}</td>
                    <td>{row.exams.reduce((n, ex) => n + ex.subjects.length, 0)}</td>
                    <td>{row.obtained}</td>
                    <td>{row.max}</td>
                    <td>{pct(row.percent)}</td>
                    {/* Marks entered from the Employee Portal name the teacher
                        here; rows saved before attribution existed show "—"
                        rather than being credited to the current viewer. */}
                    <td>
                      {row.enteredBy.length
                        ? row.enteredBy.join(', ')
                        : <span className="text-muted">—</span>}
                    </td>
                    <td>
                      {row.updatedBy.length
                        ? `${row.updatedBy.join(', ')}${row.latest ? ` · ${shortStamp(row.latest)}` : ''}`
                        : <span className="text-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
{bulkOpen && (
        <Modal
          title={activeLabel ? `Bulk Upload Marks — ${activeLabel}` : 'Bulk Upload Marks'}
          onClose={() => setBulkOpen(false)}
          footer={
            <button className="btn btn-secondary" onClick={() => setBulkOpen(false)}>Close</button>
          }
        >
          {bulkErrors.length > 0 && (
            <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>
              <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {bulkErrors.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </div>
          )}

          <div className="text-sm" style={{ marginBottom: 'var(--sp-md)' }}>
            Bulk upload marks for <b>{activeLabel || 'the selected class'}</b> — every row must
            belong to a student of this class. Rows for students of any other class are rejected,
            and nothing is saved.
          </div>

          <div className="form-group">
            <label className="form-label">Upload a spreadsheet (.csv or .xlsx)</label>
            <input
              type="file"
              className="form-input"
              accept=".csv,.xlsx"
              disabled={bulkBusy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ''; // allow re-choosing the same file after a failed attempt
                if (file) handleBulk(file);
              }}
              aria-label="Bulk upload marks file"
            />
          </div>

          <div className="text-sm" style={{ marginTop: 'var(--sp-sm)' }}>
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); downloadTemplate(); }}
              aria-label="Download marks upload template"
            >
              {downloading ? 'Preparing template…' : 'Download template'}
            </a>
          </div>

          <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
            Header row required, in this order: {BULK_COLUMNS.join(', ')}.<br />
            One row per student per subject — students are matched by RollNumber (never by name),
            and only within {activeLabel || 'the selected class'}. The class is not part of the
            file: it comes from the Select Class dropdown on this page. Subject is free text, so
            any admin-defined subject is accepted. Up to 200 rows per file, saved atomically: if
            any row is invalid, nothing is saved and the failing rows and columns are listed here.
          </div>
        </Modal>
      )}
    </div>
  );
}
