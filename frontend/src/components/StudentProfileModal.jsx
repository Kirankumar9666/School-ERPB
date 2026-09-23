import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Award, CalendarDays, Eye, FileText, KeyRound, Phone, User, Wallet,
} from 'lucide-react';
import Modal from './Modal';
import AttendanceMonthCalendar from './AttendanceMonthCalendar';
import api from '../services/api';
import { initials } from '../utils/date';

/** Age in whole years from a 'YYYY-MM-DD' DOB (null when unknown) */
const ageFromDob = (dob) => {
  if (!dob) return null;
  const born = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const beforeBirthday =
    now.getMonth() < born.getMonth()
    || (now.getMonth() === born.getMonth() && now.getDate() < born.getDate());
  if (beforeBirthday) age -= 1;
  return age;
};

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
const fmtDate = (iso) => (iso
  ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

/**
 * StudentProfileModal — everything about one student in one place, opened from
 * the Class Detail popup's "View" action (AdminStudents).
 *
 * Sections mirror the Employee Profile page (icon + label section headers over
 * an info grid). Every field is read live from that student's real records at
 * open time — the profile payload (/students/:id/profile), the month
 * attendance summary + calendar (/students/:id/attendance via the shared
 * AttendanceMonthCalendar), the full marks history (/students/:id/marks — the
 * same data Marks Entry's "Saved Marks" table shows, scoped to this student)
 * and the document records (/admin/students/:id/documents). Nothing is
 * hardcoded, so the view is accurate for any student clicked.
 *
 * @param {object} student  the roster row (id + name at minimum)
 * @param {function} onClose
 */
export default function StudentProfileModal({ student, onClose }) {
  const [profile, setProfile] = useState(null);
  const [marks, setMarks] = useState([]);
  const [docs, setDocs] = useState(null);
  const [attSummary, setAttSummary] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  // Nested "All Exams" popup, opened from the View All button on the
  // Marks & Academic Performance section header (profile modal stays open
  // underneath).
  const [examsOpen, setExamsOpen] = useState(false);
  const viewAllRef = useRef(null); // focus returns here when the popup closes

  useEffect(() => {
    if (!student?.id) return undefined;
    let alive = true;
    Promise.all([
      api.get(`/students/${student.id}/profile`),
      api.get(`/students/${student.id}/marks`),
      api.get(`/admin/students/${student.id}/documents`).catch(() => null), // optional section
    ])
      .then(([p, m, d]) => {
        if (!alive) return;
        setProfile(p.data.data);
        setMarks(m.data.data || []);
        setDocs(d?.data?.data ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [student?.id]);

  /* Marks aggregates for THIS student only — computed from the same grouped
     exam data the Saved Marks table renders. */
  const rows = marks.flatMap((ex) => ex.subjects.map((s) => ({ ...s, examName: ex.examName, date: ex.date })));
  const totalMax = rows.reduce((n, r) => n + (Number(r.maxMarks) || 0), 0);
  const totalObtained = rows.reduce((n, r) => n + (Number(r.obtained) || 0), 0);
  const average = totalMax ? (totalObtained / totalMax) * 100 : null;
  const top = rows.length
    ? rows.reduce((best, r) => ((r.maxMarks ? r.obtained / r.maxMarks : 0) > (best.maxMarks ? best.obtained / best.maxMarks : 0) ? r : best))
    : null;
  const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);

  return (
    <Modal
      wide
      title={profile ? `Student Profile — ${profile.name}` : 'Student Profile'}
      onClose={onClose}
      footer={<button className="btn btn-secondary" onClick={onClose}>Close</button>}
    >
      {loading && <div className="loading-center"><div className="spinner" /></div>}

      {!loading && failed && (
        <div className="empty-state">
          Could not load this student&apos;s profile.
          <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>Close and try again.</div>
        </div>
      )}

      {!loading && profile && (
        <>
          {/* Identity header — same treatment as the Employee Profile card */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-lg)', marginBottom: 'var(--sp-lg)' }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, var(--clr-primary), var(--clr-accent))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 24, fontWeight: 800,
            }}>
              {initials(profile.name)}
            </div>
            <div>
              <div style={{ fontSize: 19, fontWeight: 700 }}>{profile.name}</div>
              <div style={{ color: 'var(--clr-text-muted)', marginTop: 4 }}>
                Class {dash(profile.class)}-{dash(profile.section)}
                {profile.rollNumber ? ` · Roll ${profile.rollNumber}` : ''}
                {profile.admissionYear ? ` · Admitted ${profile.admissionYear}` : ''}
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-title"><User size={14} /> Personal Information</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Full Name</span><span className="info-value">{dash(profile.name)}</span></div>
                <div className="info-item"><span className="info-label">Roll Number</span><span className="info-value">{dash(profile.rollNumber)}</span></div>
                <div className="info-item"><span className="info-label">Class &amp; Section</span><span className="info-value">{profile.class ? `${profile.class}-${profile.section}` : '—'}</span></div>
                <div className="info-item"><span className="info-label">Date of Birth</span><span className="info-value">{dash(profile.dob)}{ageFromDob(profile.dob) !== null ? ` (${ageFromDob(profile.dob)} yrs)` : ''}</span></div>
                <div className="info-item"><span className="info-label">Blood Group</span><span className="info-value">{dash(profile.bloodGroup)}</span></div>
                <div className="info-item"><span className="info-label">Admission Year</span><span className="info-value">{dash(profile.admissionYear)}</span></div>
                <div className="info-item" style={{ gridColumn: '1 / -1' }}>
                  <span className="info-label">Address</span>
                  <span className="info-value">{dash(profile.address)}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-title"><Phone size={14} /> Guardian &amp; Contact</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Parent / Guardian</span><span className="info-value">{dash(profile.parentName)}</span></div>
                <div className="info-item"><span className="info-label">Guardian Contact</span><span className="info-value">{dash(profile.guardianContact)}</span></div>
              </div>
            </div>
          </div>
          <div className="section">
            <div className="section-title"><KeyRound size={14} /> Login Account</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Username</span><span className="info-value">{dash(profile.username)}</span></div>
                <div className="info-item"><span className="info-label">Initial Password</span><span className="info-value">{profile.username ? `${dash(profile.guardianContact)} — the guardian's contact number` : '—'}</span></div>
                <div className="info-item" style={{ gridColumn: '1 / -1' }}>
                  <span className="info-label">Note</span>
                  <span className="info-value">
                    {profile.username
                      ? 'Role: STUDENT — the initial password is the guardian contact; reset it from User Accounts after handing over the login.'
                      : 'No login account (this student was created without a guardian contact, so no password could be derived).'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-title"><Wallet size={14} /> Fee Details</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Fee Total</span><span className="info-value">{profile.feeTotal != null ? money(profile.feeTotal) : '—'}</span></div>
                <div className="info-item"><span className="info-label">Fee Dues</span><span className="info-value">{profile.feeDues != null ? money(profile.feeDues) : '—'}</span></div>
                <div className="info-item"><span className="info-label">Fee Paid</span><span className="info-value">{profile.feeTotal != null && profile.feeDues != null ? money(profile.feeTotal - profile.feeDues) : '—'}</span></div>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-title"><CalendarDays size={14} /> Attendance</div>
            <div className="card">
              {attSummary && (
                <div className="modal-meta" style={{ marginBottom: 'var(--sp-md)' }}>
                  <div>
                    <div className="modal-meta-label">Present</div>
                    <div className="modal-meta-value">{attSummary.present ?? 0}</div>
                  </div>
                  <div>
                    <div className="modal-meta-label">Absent</div>
                    <div className="modal-meta-value">{attSummary.absent ?? 0}</div>
                  </div>
                  <div>
                    <div className="modal-meta-label">Half Days</div>
                    <div className="modal-meta-value">{attSummary.halfDay ?? 0}</div>
                  </div>
                  <div>
                    <div className="modal-meta-label">Attendance</div>
                    <div className="modal-meta-value">{attSummary.percent != null ? `${Math.round(attSummary.percent)}%` : '—'}</div>
                  </div>
                </div>
              )}
              <AttendanceMonthCalendar studentId={student.id} onSummary={setAttSummary} />
            </div>
          </div>

          <div className="section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-md)' }}>
              <div className="section-title"><Award size={14} /> Marks &amp; Academic Performance</div>
              <button
                ref={viewAllRef}
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setExamsOpen(true)}
              >
                <Eye size={14} /> View All Exams
              </button>
            </div>
            <div className="card">
              <div className="modal-meta" style={{ marginBottom: rows.length ? 'var(--sp-md)' : 0 }}>
                <div>
                  <div className="modal-meta-label">Average Score</div>
                  <div className="modal-meta-value">{pct(average)}</div>
                </div>
                <div>
                  <div className="modal-meta-label">Top Score</div>
                  <div className="modal-meta-value">{top && top.maxMarks ? `${top.obtained}/${top.maxMarks}` : '—'}</div>
                </div>
                <div>
                  <div className="modal-meta-label">Exams</div>
                  <div className="modal-meta-value">{marks.length}</div>
                </div>
              </div>
              {rows.length === 0 ? (
                <div className="text-muted">No marks recorded yet for this student.</div>
              ) : (
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr><th>Exam</th><th>Date</th><th>Subject</th><th>Max</th><th>Obtained</th><th>%</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={`${r.examName}-${r.subject}-${i}`}>
                          <td>{r.examName}</td>
                          <td>{fmtDate(r.date)}</td>
                          <td>{r.subject}</td>
                          <td>{r.maxMarks}</td>
                          <td><b>{r.obtained}</b></td>
                          <td>{r.maxMarks ? pct((r.obtained / r.maxMarks) * 100) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="section">
            <div className="section-title"><FileText size={14} /> Documents</div>
            {docs === null ? (
              <div className="card"><div className="text-muted">Documents could not be loaded.</div></div>
            ) : docs.length === 0 ? (
              <div className="card"><div className="text-muted">No documents uploaded yet — manage them from the Documents page.</div></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-sm)' }}>
                {docs.map((d) => (
                  <div key={d.id} className="doc-item">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                      <div className="doc-icon"><FileText size={20} /></div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{d.fileName}</div>
                        <div className="text-sm text-muted">{d.type} • uploaded {fmtDate(d.uploadedAt)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Nested "All Exams" popup — stacked above this profile modal, which
          stays open-but-dimmed underneath. Reuses the marks already fetched
          for the profile (the same data Marks Entry's "Saved Marks" table
          shows), so nothing is re-requested and nothing is hardcoded. */}
      {examsOpen && profile && (
        <Modal
          wide
          stacked
          returnFocusRef={viewAllRef}
          title={`All Exams — ${profile.name}`}
          onClose={() => setExamsOpen(false)}
          footer={<button className="btn btn-secondary" onClick={() => setExamsOpen(false)}>Close</button>}
        >
          {rows.length === 0 ? (
            <div className="empty-state">No exams recorded yet for {profile.name}.</div>
          ) : (
            <>
              <div className="modal-meta" style={{ marginBottom: 'var(--sp-md)' }}>
                <div>
                  <div className="modal-meta-label">Total Exams</div>
                  <div className="modal-meta-value">{marks.length}</div>
                </div>
                <div>
                  <div className="modal-meta-label">Overall Average</div>
                  <div className="modal-meta-value">{pct(average)}</div>
                </div>
                <div>
                  <div className="modal-meta-label">Top Score</div>
                  <div className="modal-meta-value">{top && top.maxMarks ? `${top.obtained}/${top.maxMarks}` : '—'}</div>
                </div>
              </div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr><th>Subject</th><th>Max Marks</th><th>Obtained</th><th>%</th></tr>
                  </thead>
                  <tbody>
                    {marks.map((ex) => (
                      <Fragment key={ex.examId}>
                        <tr>
                          <td colSpan={4} style={{ background: 'var(--paper-2)', fontWeight: 700 }}>
                            {ex.examName} · {fmtDate(ex.date)}
                          </td>
                        </tr>
                        {ex.subjects.map((s, i) => (
                          <tr key={`${ex.examId}-${s.subject}-${i}`}>
                            <td>{s.subject}</td>
                            <td>{s.maxMarks}</td>
                            <td><b>{s.obtained}</b></td>
                            <td>{s.maxMarks ? pct((s.obtained / s.maxMarks) * 100) : '—'}</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Modal>
      )}
    </Modal>
  );
}
