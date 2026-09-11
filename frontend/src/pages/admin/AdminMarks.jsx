import { useEffect, useState } from 'react';
import { Plus, Trash, Upload } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

const subjectRow = (subject = '', maxMarks = 100, obtained = '') => ({ subject, maxMarks, obtained });

/**
 * Admin Marks — upload exam marks for a student.
 */
export default function AdminMarks() {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [studentId, setStudentId] = useState('');
  const [examName, setExamName] = useState('');
  const [date, setDate] = useState('');
  const [rows, setRows] = useState([subjectRow('Mathematics'), subjectRow('Science'), subjectRow('English')]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/admin/students')
      .then((r) => {
        setStudents(r.data.data);
        setStudentId(r.data.data[0]?.id || '');
      })
      .finally(() => setLoading(false));
  }, []);

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
    try {
      await api.post('/admin/marks', { studentId, examName: examName.trim(), date: date || undefined, subjects: clean });
      toast.success('Marks uploaded!');
      setExamName('');
      setDate('');
      setRows([subjectRow('Mathematics'), subjectRow('Science'), subjectRow('English')]);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not upload marks.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Marks Entry</div>
        <div className="page-subtitle">Upload exam results per student</div>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-lg)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--sp-md)' }}>
            <div className="form-group">
              <label className="form-label">Student *</label>
              <select className="form-input" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
                {students.map((s) => <option key={s.id} value={s.id}>{s.name} — Class {s.class}-{s.section}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Exam Name *</label>
              <input className="form-input" value={examName} onChange={(e) => setExamName(e.target.value)} placeholder="e.g. Unit Test 2" />
            </div>
            <div className="form-group">
              <label className="form-label">Exam Date</label>
              <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
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
                    <td><input className="form-input" value={r.subject} onChange={setRow(i, 'subject')} placeholder="Subject" /></td>
                    <td><input className="form-input" type="number" min="1" value={r.maxMarks} onChange={setRow(i, 'maxMarks')} /></td>
                    <td><input className="form-input" type="number" min="0" value={r.obtained} onChange={setRow(i, 'obtained')} /></td>
                    <td>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => removeRow(i)} aria-label="Remove row">
                        <Trash size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 'var(--sp-md)', alignItems: 'center' }}>
            <button type="button" className="btn btn-secondary" onClick={addRow}>
              <Plus size={16} /> Add Subject
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Upload size={16} /> {saving ? 'Uploading...' : 'Upload Marks'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}