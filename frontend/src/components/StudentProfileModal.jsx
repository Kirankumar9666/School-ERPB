import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Award, CalendarDays, Eye, FileText, KeyRound, Phone, User, Wallet,
} from 'lucide-react';
import Modal from './Modal';
import AttendanceMonthCalendar from './AttendanceMonthCalendar';
import FeeLedgerTable from './FeeLedgerTable';
import { money as feeMoney, dash as feeDash, fmtDate as feeDate } from '../utils/feeFormat';
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

const money = feeMoney;
const dash = feeDash;
const fmtDate = feeDate;

/**
 * StudentProfileModal — everything about one student in one place, opened from
 * the Class Detail popup's "View" action (AdminStudents) and from a Class History
 * row.
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
 * ## `academicYearId` — the same modal, scoped to one year
 *
 * Pass a year and the modal answers a DIFFERENT question: what this child's
 * record says for that year, not what it says today. Class History opens it that
 * way, because a promoted child's 2024-25 class, roll number, attendance and
 * results are not recoverable from their current ones — the whole point of
 * tracking a class per year.
 *
 * It is the same dialog, not a second one, so the shell, accessibility and
 * nested-exam behaviour stay identical; only the source of the truth changes.
 * In year mode the modal:
 *
 *   - shows a banner naming the year, and that year's class and roll number;
 *   - renders the BACKFILLED yearly totals (days present / absent / working
 *     days) instead of a day-by-day calendar, because a register typed in after
 *     the fact has no days to show — and says so plainly instead of drawing an
 *     empty month;
 *   - shows that year's results only;
 *   - OMITS the fee, login and document sections. Those are single current
 *     values, not per-year ones, so displaying them under a 2024-25 heading
 *     would state today's truth as though it were that year's.
 *
 * @param {object} student  the roster row (id + name at minimum)
 * @param {string} [academicYearId] scope everything to this academic year
 * @param {function} onClose
 */
export default function StudentProfileModal({ student, academicYearId, onClose }) {
  const [profile, setProfile] = useState(null);
  const [marks, setMarks] = useState([]);
  const [docs, setDocs] = useState(null);
  const [attSummary, setAttSummary] = useState(null);
  // Current + carried-forward fee picture, read from the same service the Fee
  // Dues page uses. Optional: a caller without fee access still sees the profile.
  const [feeSummary, setFeeSummary] = useState(null);
  const [feeLedger, setFeeLedger] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  // Nested "All Exams" popup, opened from the View All button on the
  // Marks & Academic Performance section header (profile modal stays open
  // underneath).
  const [examsOpen, setExamsOpen] = useState(false);
  const viewAllRef = useRef(null); // focus returns here when the popup closes
  /* "Create login" — for a student who has no account. Null until one is
     created, then { username }: the response states the initial password's
     source once and never again, exactly as the Add Student flow does. */
  const [creatingLogin, setCreatingLogin] = useState(false);
  const [createdLogin, setCreatedLogin] = useState(null);
  const [createLoginError, setCreateLoginError] = useState('');

  /* Year-scoped state. Class History opens this modal with an `academicYearId`,
     in which case the three live endpoints above have no year filter and would
     answer "today" no matter which year was asked for — so this branch loads the
     single endpoint that reads the enrollment table for THAT year instead. */
  const [yearView, setYearView] = useState(null);
  const [yearFailed, setYearFailed] = useState(false);

  useEffect(() => {
    // Skipped in year mode: those requests would be thrown away, and the
    // `loading: false` they set would flash the empty shell before the real
    // payload arrives.
    if (!student?.id || academicYearId) return undefined;
    let alive = true;
    Promise.all([
      api.get(`/students/${student.id}/profile`),
      // Marks, documents and fees are all OPTIONAL sections: a caller without
      // access to one (e.g. the accountant, who sees identity + guardian +
      // fees but not marks) still gets the profile instead of the whole modal
      // failing. Each absent section renders its own honest empty note.
      api.get(`/students/${student.id}/marks`).catch(() => null),
      api.get(`/admin/students/${student.id}/documents`).catch(() => null), // admin-only section
      api.get(`/students/${student.id}/fees`).catch(() => null), // optional section
    ])
      .then(([p, m, d, f]) => {
        if (!alive) return;
        setProfile(p.data.data);
        setMarks(m?.data?.data || []);
        setDocs(d?.data?.data ?? null);
        setFeeSummary(f?.data?.data?.summary ?? null);
        setFeeLedger(f?.data?.data ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [student?.id, academicYearId]);

  useEffect(() => {
    if (!academicYearId || !student?.id) return undefined;
    let alive = true;
    setYearView(null);
    setYearFailed(false);
    setLoading(true);
    api.get(`/admin/class-management/students/${student.id}/years/${academicYearId}`)
      .then((r) => {
        if (!alive) return;
        setYearView(r.data.data);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setYearFailed(true);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [student?.id, academicYearId]);

  /* Provision the missing login. Admin-only on the server; this modal is only
     ever opened from the admin panel's Student Management / Class History
     screens. On success the profile itself is updated so the section reads as
     any other student's immediately — a refetch would flicker the whole modal. */
  const createLogin = async () => {
    setCreatingLogin(true);
    setCreateLoginError('');
    try {
      const res = await api.post(`/admin/students/${student.id}/create-login`);
      const username = res.data.data?.account?.username || null;
      setCreatedLogin(username);
      if (username) setProfile((p) => (p ? { ...p, username } : p));
    } catch (err) {
      setCreateLoginError(err.response?.data?.message || 'Could not create the login.');
    } finally {
      setCreatingLogin(false);
    }
  };

  /* Marks aggregates for THIS student only — computed from the same grouped
     exam data the Saved Marks table renders. */  const rows = marks.flatMap((ex) => ex.subjects.map((s) => ({ ...s, examName: ex.examName, date: ex.date })));
  const totalMax = rows.reduce((n, r) => n + (Number(r.maxMarks) || 0), 0);
  const totalObtained = rows.reduce((n, r) => n + (Number(r.obtained) || 0), 0);
  const average = totalMax ? (totalObtained / totalMax) * 100 : null;
  const top = rows.length
    ? rows.reduce((best, r) => ((r.maxMarks ? r.obtained / r.maxMarks : 0) > (best.maxMarks ? best.obtained / best.maxMarks : 0) ? r : best))
    : null;
  const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);

  /* The accountant's restricted payload (services/studentAccess.js → BASIC)
     carries name/class/guardian only and NOT admissionYear, so its absence is
     how this modal recognises "you are seeing the fee-desk projection". Used
     below to avoid claiming "No marks recorded" when marks were simply not
     readable for this caller — those are different statements. */
  const restrictedView = Boolean(profile && !('admissionYear' in profile));

  /* ── Year-scoped view (Class History) ─────────────────────────────────────
     Returns early so the live sections below are never rendered in year mode:
     each of them reads a current single-value field, and showing today's fee
     balance under a "2024-25" heading would state it as though it were that
     year's. */
  if (academicYearId) {
    const view = yearView;
    const enr = view?.enrollment;
    const att = view?.attendance;
    const backfilled = att?.backfilled || null;
    const daily = att?.daily || null;
    const yRows = view?.marks || [];
    const yMax = yRows.reduce((n, r) => n + (Number(r.maxMarks) || 0), 0);
    const yObtained = yRows.reduce((n, r) => n + (Number(r.obtained) || 0), 0);
    const yAverage = yMax ? (yObtained / yMax) * 100 : null;
    const attPercent = backfilled && backfilled.workingDays
      ? (backfilled.daysPresent / backfilled.workingDays) * 100
      : null;

    return (
      <Modal
        wide
        title={view ? `${view.student.name} — ${view.academicYear.label}` : 'Student Record'}
        onClose={onClose}
        footer={<button className="btn btn-secondary" onClick={onClose}>Close</button>}
      >
        {loading && <div className="loading-center"><div className="spinner" /></div>}

        {!loading && yearFailed && (
          <div className="empty-state">
            Could not load this student&apos;s record for that year.
            <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>Close and try again.</div>
          </div>
        )}

        {!loading && view && (
          <>
            {/* Year banner — the one thing that must never be missed, because the
                rest of this page looks exactly like a live profile. */}
            <div className="att-note" style={{ marginBottom: 'var(--sp-lg)' }}>
              <strong>{view.academicYear.label}</strong>
              {' · '}
              {view.academicYear.startDate} to {view.academicYear.endDate}
              <div style={{ marginTop: 4 }}>
                {enr
                  ? <>
                    {enr.classLabel}
                    {enr.rollNumber ? ` · Roll ${enr.rollNumber}` : ' · No roll number recorded'}
                    {' · '}
                    <span className={`badge ${enr.status === 'active' ? 'badge-active' : 'badge-muted'}`}>
                      {enr.status.replace(/_/g, ' ')}
                    </span>
                    {' '}
                    {enr.source === 'historical' && <span className="badge badge-info">backfilled</span>}
                    {enr.source === 'promoted' && <span className="badge badge-primary">promoted in</span>}
                  </>
                  : 'This student was not on any class register for this year.'}
              </div>
              {view.student.hasCurrentClass && (
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  Now in {view.student.currentClassLabel} — this page shows the year above, not today.
                </div>
              )}
            </div>

            <div className="section">
              <div className="section-title"><User size={14} /> Identity &amp; Guardian</div>
              <div className="card">
                <div className="info-grid">
                  <div className="info-item"><span className="info-label">Full Name</span><span className="info-value">{dash(view.student.name)}</span></div>
                  <div className="info-item"><span className="info-label">Parent / Guardian</span><span className="info-value">{dash(view.student.parentName)}</span></div>
                  <div className="info-item"><span className="info-label">Guardian Contact</span><span className="info-value">{dash(view.student.guardianContact)}</span></div>
                  <div className="info-item">
                    <span className="info-label">Class &amp; Section</span>
                    <span className="info-value">{enr ? enr.classLabel : '—'}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Roll Number (that year)</span>
                    <span className="info-value">{enr ? dash(enr.rollNumber) : '—'}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="section">
              <div className="section-title"><CalendarDays size={14} /> Attendance — {view.academicYear.label}</div>
              <div className="card">
                {backfilled ? (
                  <>
                    <div className="modal-meta">
                      <div>
                        <div className="modal-meta-label">Working Days</div>
                        <div className="modal-meta-value">{backfilled.workingDays}</div>
                      </div>
                      <div>
                        <div className="modal-meta-label">Present</div>
                        <div className="modal-meta-value">{backfilled.daysPresent}</div>
                      </div>
                      <div>
                        <div className="modal-meta-label">Absent</div>
                        <div className="modal-meta-value">{backfilled.daysAbsent}</div>
                      </div>
                      <div>
                        <div className="modal-meta-label">Attendance</div>
                        <div className="modal-meta-value">{pct(attPercent)}</div>
                      </div>
                    </div>
                    <div className="info-note">
                      These are the yearly totals recorded from the register. No day-by-day
                      calendar is shown, because a record entered after the year has no
                      individual days to show.
                    </div>
                  </>
                ) : daily && daily.recorded ? (
                  <>
                    <div className="modal-meta">
                      <div>
                        <div className="modal-meta-label">Present</div>
                        <div className="modal-meta-value">{daily.present}</div>
                      </div>
                      <div>
                        <div className="modal-meta-label">Absent</div>
                        <div className="modal-meta-value">{daily.absent}</div>
                      </div>
                      <div>
                        <div className="modal-meta-label">Days Recorded</div>
                        <div className="modal-meta-value">{daily.total}</div>
                      </div>
                    </div>
                    <div className="info-note">
                      Counted from the daily register entries dated inside this year.
                    </div>
                  </>
                ) : (
                  <div className="text-muted">
                    No attendance was recorded for this year — neither a yearly summary
                    nor any daily entries.
                  </div>
                )}
              </div>
            </div>

            <div className="section">
              <div className="section-title"><Award size={14} /> Results — {view.academicYear.label}</div>
              <div className="card">
                <div className="modal-meta" style={{ marginBottom: yRows.length ? 'var(--sp-md)' : 0 }}>
                  <div>
                    <div className="modal-meta-label">Average</div>
                    <div className="modal-meta-value">{pct(yAverage)}</div>
                  </div>
                  <div>
                    <div className="modal-meta-label">Results Recorded</div>
                    <div className="modal-meta-value">{yRows.length}</div>
                  </div>
                  <div>
                    <div className="modal-meta-label">Total Marks</div>
                    <div className="modal-meta-value">{yMax || '—'}</div>
                  </div>
                </div>
                {yRows.length === 0 ? (
                  <div className="text-muted">No exam results recorded for this year.</div>
                ) : (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th>Exam</th><th>Date</th><th>Subject</th>
                          <th>Max</th><th>Obtained</th><th>%</th><th>How recorded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {yRows.map((r, i) => (
                          <tr key={`${r.examName}-${r.subject}-${i}`}>
                            <td>{r.examName}</td>
                            {/* An undated backfilled exam renders as "—" rather than a
                                guessed day: the register knew the year, not the date. */}
                            <td>{fmtDate(r.examDate)}</td>
                            <td>{r.subject}</td>
                            <td>{r.maxMarks}</td>
                            <td><b>{r.obtained}</b></td>
                            <td>{r.maxMarks ? pct((r.obtained / r.maxMarks) * 100) : '—'}</td>
                            {/* The source flag, so a figure typed in from a
                                register is never read as something the school
                                recorded on the day. */}
                            <td>
                              <span className={`badge ${r.examSource === 'historical' ? 'badge-info' : 'badge-muted'}`}>
                                {r.examSource === 'historical' ? 'backfilled' : 'entered live'}
                              </span>
                              {r.enteredBy && (
                                <div className="text-sm text-muted">by {r.enteredBy}</div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="section">
              <div className="section-title"><Wallet size={14} /> Fee — {view.academicYear.label}</div>
              <div className="card">
                <div className="info-grid">
                  <div className="info-item">
                    <span className="info-label">Fee for this year</span>
                    <span className="info-value">
                      {view.fee.isSet ? money(view.fee.total) : <span className="badge badge-muted">Not set</span>}
                    </span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Paid</span>
                    <span className="info-value">{money(view.fee.paid)}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Balance</span>
                    <span className="info-value">
                      {view.fee.balance != null ? money(view.fee.balance) : '—'}
                    </span>
                  </div>
                </div>
                {view.fee.payments?.length > 0 && (
                  <div style={{ marginTop: 'var(--sp-md)' }}>
                    <div className="text-sm text-muted" style={{ marginBottom: 6 }}>
                      Payments recorded against this year
                    </div>
                    <div className="table-wrapper">
                      <table>
                        <thead>
                          <tr><th>Date</th><th>Amount</th><th>Class &amp; year paid</th><th>Note</th><th>Recorded by</th></tr>
                        </thead>
                        <tbody>
                          {view.fee.payments.map((p, i) => (
                            <tr key={`${p.paidOn}-${i}`}>
                              <td>{fmtDate(p.paidOn)}</td>
                              <td>{money(p.amount)}</td>
                              <td>
                                {p.classLabel ? `${p.classLabel} · ${p.academicYearLabel}` : p.academicYearLabel}
                                {p.chosenYear && (
                                  <span className="badge badge-muted" style={{ marginLeft: 6 }} title="This year was chosen by hand, not by the oldest-first rule">
                                    year chosen
                                  </span>
                                )}
                              </td>
                              <td>{p.note || '—'}</td>
                              <td>{p.recordedBy || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="info-note">
              The login account and uploaded documents are single current records rather
              than per-year ones, so they are not shown here — they stay on the Students
              page. The fee above is this year&apos;s own record.
            </div>
          </>
        )}
      </Modal>
    );
  }

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

          {!restrictedView && (
          <div className="section">
            <div className="section-title"><User size={14} /> Personal Information</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Full Name</span><span className="info-value">{dash(profile.name)}</span></div>
                <div className="info-item"><span className="info-label">Roll Number</span><span className="info-value">{dash(profile.rollNumber)}</span></div>
                <div className="info-item"><span className="info-label">Class &amp; Section</span><span className="info-value">{profile.classLabel || (profile.class ? `Class ${profile.class}-${profile.section}` : '—')}</span></div>
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
          )}

          <div className="section">
            <div className="section-title"><Phone size={14} /> Guardian &amp; Contact</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Parent / Guardian</span><span className="info-value">{dash(profile.parentName)}</span></div>
                <div className="info-item"><span className="info-label">Guardian Contact</span><span className="info-value">{dash(profile.guardianContact)}</span></div>
              </div>
            </div>
          </div>

          {restrictedView && (
            <div className="info-note" style={{ marginTop: 'var(--sp-md)' }}>
              You are seeing the fee-desk view of this student: name, class, roll
              number and guardian contact. Attendance, marks and documents are not
              shown to this role.
            </div>
          )}
          {!restrictedView && (
          <div className="section">
            <div className="section-title"><KeyRound size={14} /> Login Account</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Username</span><span className="info-value">{dash(profile.username)}</span></div>
                <div className="info-item" style={{ gridColumn: '1 / -1' }}>
                  <span className="info-label">Password</span>
                  <span className="info-value">
                    {profile.username
                      ? 'Role: STUDENT — set by the school at admission and never returned to this screen or any other read endpoint. It is shown once, in the response of the Add Student request that created the account, and the student must change it at first login. If it is lost, set a new one from User Accounts — it cannot be read back.'
                      : profile.guardianContact
                        ? 'No login account yet. Every student admitted today gets one automatically; this record predates that (or was seeded without one). Create it below — the initial password is the guardian contact.'
                        : 'No login account (this student was created without a guardian contact, so no password could be derived).'}
                  </span>
                </div>
              </div>
              {/* A student with no account and a guardian contact can be given
                  one here. Both conditions matter: with an account already in
                  place the action would have to overwrite a working login, and
                  with no contact there is no password to derive — so the button
                  is offered only when it can actually succeed, and the reason it
                  is absent is stated either way. */}
              {!profile.username && (
                <div style={{ marginTop: 'var(--sp-md)' }}>
                  {createdLogin ? (
                    <div className="info-note">
                      Login created: <strong>{createdLogin}</strong> — the initial
                      password is the guardian contact. It is shown in this
                      response only and cannot be retrieved afterwards; the
                      student must change it at first login.
                    </div>
                  ) : profile.guardianContact ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={createLogin}
                        disabled={creatingLogin}
                      >
                        <KeyRound size={14} /> {creatingLogin ? 'Creating…' : 'Create login'}
                      </button>
                      <div className="text-sm text-muted" style={{ marginTop: 6 }}>
                        Creates the student&apos;s login with the same rule as a new
                        admission: username from the name, initial password = the
                        guardian contact ({dash(profile.guardianContact)}), which must
                        be changed at first login.
                      </div>
                      {createLoginError && (
                        <div className="login-error" style={{ marginTop: 6 }}>{createLoginError}</div>
                      )}
                    </>
                  ) : (
                    <div className="text-sm text-muted">
                      A login cannot be created yet — there is no guardian contact on
                      file, and the initial password is the guardian contact. Add one
                      with Edit Student first.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          )}

          <div className="section">
            <div className="section-title"><Wallet size={14} /> Fee Details</div>
            {feeSummary ? (
              <div className="card">
                <div className="info-grid">
                  <div className="info-item">
                    <span className="info-label">
                      Current year{feeSummary.current?.academicYearLabel ? ` (${feeSummary.current.academicYearLabel})` : ''}
                    </span>
                    <span className="info-value">
                      {feeSummary.current?.isSet
                        ? money(feeSummary.current.total)
                        : <span className="badge badge-muted">Not set</span>}
                    </span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Current year paid</span>
                    <span className="info-value">{feeSummary.current?.isSet ? money(feeSummary.current.paid) : '—'}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Current year balance</span>
                    <span className="info-value">
                      {feeSummary.current?.balance != null ? money(feeSummary.current.balance) : '—'}
                    </span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Previous dues</span>
                    <span className="info-value">{money(feeSummary.previousDues)}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Total due</span>
                    <span className="info-value"><b>{money(feeSummary.totalDue)}</b></span>
                  </div>
                </div>
                {feeSummary.previous?.length > 0 && (
                  <div style={{ marginTop: 'var(--sp-md)' }}>
                    <div className="text-sm text-muted" style={{ marginBottom: 6 }}>
                      Carried forward from earlier years — this is what makes up the previous dues
                    </div>
                    <div className="table-wrapper">
                      <table>
                        <thead>
                          <tr><th>Year</th><th>Class</th><th>Still due</th></tr>
                        </thead>
                        <tbody>
                          {feeSummary.previous.map((p) => (
                            <tr key={p.id}>
                              <td>{p.academicYearLabel}</td>
                              <td>{p.classLabel || '—'}</td>
                              <td><span className="badge badge-danger">{money(p.balance)}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                <div className="info-note" style={{ marginTop: 'var(--sp-md)' }}>
                  Current year and previous years are kept as separate records. Payments are
                  applied to the oldest outstanding year first.
                </div>

                {/* The payment history itself: every year, every payment, with the
                    class and year each one paid — the same component the Record
                    Payment modal and the Fee Dues row draw with, so the three cannot
                    disagree about where money went. */}
                {feeLedger?.rows?.length > 0 && (
                  <div style={{ marginTop: 'var(--sp-md)' }}>
                    <FeeLedgerTable rows={feeLedger.rows} showPayments={false} title="Payments" />
                  </div>
                )}
              </div>
            ) : (
              <div className="card">
                <div className="info-grid">
                  <div className="info-item"><span className="info-label">Fee Total</span><span className="info-value">{profile.feeTotal != null ? money(profile.feeTotal) : '—'}</span></div>
                  <div className="info-item"><span className="info-label">Fee Dues</span><span className="info-value">{profile.feeDues != null ? money(profile.feeDues) : '—'}</span></div>
                  <div className="info-item"><span className="info-label">Fee Paid</span><span className="info-value">{profile.feeTotal != null && profile.feeDues != null ? money(profile.feeTotal - profile.feeDues) : '—'}</span></div>
                </div>
              </div>
            )}
          </div>

          {!restrictedView && (
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
              <AttendanceMonthCalendar personId={student.id} onSummary={setAttSummary} />
            </div>
          </div>
          )}

          {!restrictedView && (
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
          )}

          {!restrictedView && (
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
          )}
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
