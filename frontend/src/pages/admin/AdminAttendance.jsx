import { useEffect, useState } from 'react';
import { CalendarDays, Save } from 'lucide-react';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import toast from 'react-hot-toast';
import { todayISO } from '../../utils/date';

/**
 * Admin Attendance — mark attendance for students or employees per day.
 * The status list is the AttendanceStatus enum served by /school/options and the
 * people lists come from the API, so nothing is a fixed local list.
 */
export default function AdminAttendance() {
  const [tab, setTab] = useState('student');
  const [students, setStudents] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [entityId, setEntityId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [status, setStatus] = useState('');
  const [workingHours, setWorkingHours] = useState('8');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/admin/students'), api.get('/admin/employees'), loadOptions()])
      .then(([s, e, o]) => {
        setStudents(s.data.data);
        setEmployees(e.data.data);
        setEntityId(s.data.data[0]?.id || e.data.data[0]?.id || '');
        setStatuses(o.enums.attendanceStatuses);
        setStatus((current) => current || o.enums.attendanceStatuses[0] || '');
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!entityId || !date) {
      toast.error('Select a person and a date.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/admin/attendance', {
        entityType: tab,
        entityId,
        date,
        status,
        workingHours: Number(workingHours) || undefined,
      });
      toast.success('Attendance marked!');
      setStatus('present');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not mark attendance.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  const list = tab === 'student' ? students : employees;
  const label = tab === 'student' ? 'Student' : 'Employee';
  const activeId = list.some((x) => x.id === entityId) ? entityId : (list[0]?.id || '');

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Mark Attendance</div>
        <div className="page-subtitle">Record daily attendance</div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button className={`tab-btn${tab === 'student' ? ' active' : ''}`} onClick={() => setTab('student')}>Students</button>
        <button className={`tab-btn${tab === 'employee' ? ' active' : ''}`} onClick={() => setTab('employee')}>Employees</button>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-lg)' }}>
          <div className="form-group">
            <label className="form-label">Select {label}</label>
            <select className="form-input" value={activeId} onChange={(e) => setEntityId(e.target.value)}>
              <option value="">— choose —</option>
              {list.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} {tab === 'student' ? `(Class ${x.class}-${x.section})` : `(${x.designation})`}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-md)' }}>
            <div className="form-group">
              <label className="form-label">Date</label>
              <input type="date" className="form-input" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Status</label>
              <select className="form-input" value={status} onChange={(e) => setStatus(e.target.value)}>
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {tab === 'employee' && (
            <div className="form-group">
              <label className="form-label">Working Hours (optional)</label>
              <input type="number" min="0" max="24" step="0.5" className="form-input" value={workingHours} onChange={(e) => setWorkingHours(e.target.value)} />
            </div>
          )}

          <button className="btn btn-primary" disabled={saving}>
            <Save size={16} /> {saving ? 'Saving...' : `Mark ${status}`}
          </button>
        </form>
      </div>

      <div className="card" style={{ marginTop: 'var(--sp-xl)', display: 'flex', gap: 'var(--sp-md)', alignItems: 'center' }}>
        <CalendarDays size={18} style={{ color: 'var(--clr-primary-h)' }} />
        <span className="text-muted">
          Tip: Students & staff see their attendance instantly on their dashboards.
        </span>
      </div>
    </div>
  );
}