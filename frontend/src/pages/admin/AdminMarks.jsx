import { useEffect, useState } from 'react';
import { Plus, Trash, Upload, FileSpreadsheet, Award, Users, ClipboardList } from 'lucide-react';
import Modal from '../../components/Modal';
import ClassSelect from '../../components/ClassSelect';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import { classChoices } from '../../utils/classes';
import toast from 'react-hot-toast';

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
 * Admin Marks — manual per-student entry plus CSV/XLSX bulk upload.
 * Both paths post to the same endpoint, so every total/average shown here is
 * derived from the marks actually stored in the database.
 */
export default function AdminMarks() {
  const [students, setStudents] = useState([]);
  const [classes, setClasses] = useState([]); // live class list (options API)
  const [classKey, setClassKey] = useState('');
  const [marks, setMarks] = useState({});
  const [loading, setLoading] = useState(true);
  const [studentId, setStudentId] = useState('');
  const [examName, setExamName] = useState('');
  const [date, setDate] = useState('');
  const [rows, setRows] = useState([subjectRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErrors, setBulkErrors] = useState([]);
  const [downloading, setDownloading] = useState(false);

  const loadStudents = () => api.get('/admin/students').then((r) => setStudents(r.data.data));

  const loadMarks = () => api.get('/admin/marks').then((r) => setMarks(r.data.data || {}));

  useEffect(() => {
    Promise.all([
      loadStudents(),
      loadMarks(),
      // Same shared class list the Timetable/Syllabus/Attendance/Documents
      // pages use — never a local copy.
      loadOptions().then((o) => setClasses(o.classes)),
    ]).finally(() => setLoading(false));
  }, []);

  /** A student row's class id ('cls-10A') — /admin/students ships grade + section */
  const classIdOfStudent = (s) => `cls-${s.class}${s.section}`;

  // Class options for the shared ClassSelect: the real classes from
  // GET /school/options, unioned with any class referenced by the student data
  // so nothing that exists is hidden (same pattern as the other pages).
  const choices = classChoices(students.map(classIdOfStudent), classes);

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

  const setRow = (i, key) => (e) => {
    const next = [...rows];
    next[i] = { ...next[i], [key]: e.target.value };
    setRows(next);
  };

  const addRow = () => setRows([...rows, subjectRow()]);
  const removeRow = (i) => setRows(rows.filter((_, idx) => idx !== i));

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
      return { student: s, exams, obtained, max, percent: max ? (obtained / max) * 100 : null };
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

      <div className="section">
        <div className="section-title"><ClipboardList size={14} /> Saved Marks</div>
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
                </tr>
              </thead>
              <tbody>
                {studentStats.map((row) => (
                  <tr key={row.student.id}>
                    <td><b>{row.student.name}</b></td>
                    <td>{row.student.class}-{row.student.section}</td>
                    <td>{row.student.rollNumber || '—'}</td>
                    <td>{row.exams.map((ex) => ex.examName).join(', ')}</td>
                    <td>{row.exams.reduce((n, ex) => n + ex.subjects.length, 0)}</td>
                    <td>{row.obtained}</td>
                    <td>{row.max}</td>
                    <td>{pct(row.percent)}</td>
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
