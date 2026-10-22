import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, GraduationCap, RotateCcw, TriangleAlert, UserCog, Users } from 'lucide-react';
import Modal from './Modal';
import ConfirmModal from './ConfirmModal';
import PromoteStudentModal from './PromoteStudentModal';
import api from '../services/api';
import toast from '../services/toast';
import { useSubmitGuard } from '../utils/useSubmitGuard';

/**
 * Promote Classes — the tab that moves a whole class up a grade at the end of the
 * year, or graduates the top class out of the school.
 *
 * ## The three-step shape is the point
 *
 *   1. A class button, one per class, computed from the class's OWN grade.
 *   2. A confirmation that says exactly what will change and what will not.
 *   3. A review of every student in the batch, with anything doubtful flagged and
 *      BLOCKING until a human answers for it.
 *
 * Step 3 exists because this is the only operation in the app that touches every
 * student in a class at once, and the failure it cannot have is a silent one: a
 * duplicate student record quietly promoted, or a child with no guardian details
 * carried forward on nothing but their name. Both are flagged here and neither is
 * resolvable without a decision, because guessing is exactly what this step is
 * there to prevent.
 *
 * ## Nothing is hardcoded
 *
 * The class list, the student counts, which grade is the top one and what each
 * class promotes INTO all come from the server, which derives them from the real
 * class table. `topGradeBasis` is shown to the admin: if it says the top grade came
 * from the classes that currently hold students, then a stale empty Class 12 that
 * nobody teaches cannot hijack the graduation button — and the admin can see that
 * it did not.
 *
 * ## The one-student path is a popup, not a pair of buttons
 *
 * The roster ("… — students") used to answer both questions for the admin: a
 * "Promote to 6A" button and a "Keep in 5A" button, each with its destination
 * already decided. Both are replaced by ONE "Promote" button that opens
 * `PromoteStudentModal`, where the class is a choice drawn from the server's own
 * class table. The year stays automatic — the popup shows it and sends nothing —
 * so this screen cannot put a child in a year the rules would refuse. The
 * whole-class buttons above are deliberately untouched.
 */

/**
 * 'Class 10A' -> '10A'; 'Nursery A' -> 'Nursery A'.
 *
 * A numbered level reads oddly as "Class Class 10A" in "Promote to 10A", so the
 * word is stripped. A NAMED level has no word to strip — "Promote to Nursery A"
 * is already right — and stripping anything from it would mangle the name.
 */
const shortClassLabel = (label) =>
  typeof label === 'string' ? label.replace(/^Class\s+/, '') : label;

/** What the top level was derived from, spelled out for the admin. */
const BASIS_TEXT = {
  classes_with_students: 'the highest level among classes that currently hold students',
  all_classes: 'the highest level of any class on file (no class currently holds students)',
};

/** Human wording for one student-review flag. */
function flagText(row) {
  const parts = [];
  if (row.flags.duplicate) {
    const names = row.flags.rivals
      .filter((r) => r.tier === 'exact')
      .map((r) => r.name);
    parts.push(
      names.length
        ? `another record carries the same name, guardian and contact: ${names.join(', ')}`
        : 'another record carries the same identity',
    );
  }
  if (row.flags.unverifiable) {
    const missing = row.flags.missingFields.map(labelMissingField).join(' and ');
    parts.push(`${missing} not on file, so this record cannot be checked against anything`);
  }
  return parts;
}

const labelMissingField = (f) => (f === 'parentName' ? 'guardian name' : 'contact number');

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

export default function ClassManagementPromote() {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(null); // the class an action is staged for
  const [busy, setBusy] = useState(false);
  const [guard, cooling] = useSubmitGuard(800);

  /* Review-screen state, opened from the promote confirmation. */
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(() => new Set());
  const [excluded, setExcluded] = useState(() => new Set());

  const load = useCallback(async () => {
    try {
      const res = await api.get('/admin/class-management/overview');
      setOverview(res.data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the class list');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const closePending = useCallback(() => { if (!busy) setPending(null); }, [busy]);

  /* ── Pass out ───────────────────────────────────────────────────────────
     No review screen: this action needs no identity decision. It moves nobody
     between classes — it only stops them holding a current one — so there is
     nothing ambiguous to resolve, and a review would be ceremony. */
  const runPassOut = async (cls) => {
    setBusy(true);
    try {
      const res = await api.post(`/admin/class-management/classes/${cls.id}/pass-out`);
      toast.success(res.data.message);
      setPending(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not mark the class as passed out');
    } finally {
      setBusy(false);
    }
  };

  /* ── Promote: confirmation first, then the review screen ─────────────── */
  const openPlan = async (cls) => {
    setPlanLoading(true);
    try {
      const res = await api.get(`/admin/class-management/classes/${cls.id}/promotion-plan`);
      setPlan(res.data.data);
      setConfirmed(new Set());
      setExcluded(new Set());
      setPending(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the promotion review');
    } finally {
      setPlanLoading(false);
    }
  };

  const toggle = (setter) => (id) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleConfirm = useMemo(() => toggle(setConfirmed), []);
  const toggleExclude = useMemo(() => toggle(setExcluded), []);

  /* Flagged students with no answer yet. Both actions are allowed — confirming
     says "this record is the right one", excluding says "leave this child
     behind" — and the requirement is only that one of them happens out loud. */
  const unanswered = useMemo(
    () => (plan?.students || []).filter(
      (s) => s.needsReview && !confirmed.has(s.studentId) && !excluded.has(s.studentId),
    ),
    [plan, confirmed, excluded],
  );

  /* How many actually move. Only a FLAGGED student can be left behind, so this is
     "everyone, less the ones the admin has deliberately answered for" — and the
     number in the button is the number the server will move. */
  const moving = plan
    ? plan.students.length - plan.students.filter((s) => excluded.has(s.studentId)).length
    : 0;

  const runPromote = async () => {
    if (!plan || unanswered.length) return;
    setBusy(true);
    try {
      const res = await api.post(`/admin/class-management/classes/${plan.sourceClass.id}/promote`, {
        confirm: [...confirmed],
        exclude: [...excluded],
      });
      toast.success(res.data.message);
      setPlan(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not promote the class');
    } finally {
      setBusy(false);
    }
  };

  /* ── Per-student management (the roster modal) ──────────────────────────
     The whole-class buttons above are the fast path for a normal year. This is
     the escape hatch for the exceptions — a child who repeats the year, one who
     leaves mid-year, or a single promotion worked out one person at a time. It
     reads the class's CURRENT-YEAR register (so a student already moved still
     shows, badged) and each row offers ONE "Promote" button, which opens a popup
     asking which class the child goes to. Both answers the popup can give go
     through the same service, and the same fee rollover, as the whole-class
     button. */
  const [rosterFor, setRosterFor] = useState(null);
  const [roster, setRoster] = useState(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rowBusy, setRowBusy] = useState(null);
  const [pendingMove, setPendingMove] = useState(null); // { cls, student, action } — pass-out only
  const [promoteStudent, setPromoteStudent] = useState(null); // the student the Promote popup is open for

  const openRoster = useCallback(async (cls) => {
    setRosterFor(cls);
    setRosterLoading(true);
    try {
      const res = await api.get(`/admin/class-management/classes/${cls.id}/students`);
      setRoster(res.data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the class roster');
      setRosterFor(null);
    } finally {
      setRosterLoading(false);
    }
  }, []);

  const closeRoster = () => {
    if (rowBusy) return;
    setRosterFor(null);
    setRoster(null);
    setPendingMove(null);
    setPromoteStudent(null);
  };

  /* Pass-out is the only action still confirmed here. Promote and repeat-the-year
     now go through the popup, which asks WHERE the child is going — a question a
     plain "are you sure?" could not ask. */
  const runMove = async () => {
    if (!pendingMove) return;
    const { student, action } = pendingMove;
    setRowBusy(student.studentId);
    try {
      const res = await api.post(`/admin/class-management/students/${student.studentId}/move`, { action });
      toast.success(res.data.message);
      setPendingMove(null);
      await Promise.all([openRoster(rosterFor), load()]);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not move the student');
    } finally {
      setRowBusy(null);
    }
  };

  /* The popup did the move; close it, refresh what is behind it, and say so. The
     two refreshes are the same pair every other action in this file performs, so
     the register count and the class cards agree with the row that just changed. */
  const finishPromote = async (message) => {
    toast.success(message);
    setPromoteStudent(null);
    await Promise.all([openRoster(rosterFor), load()]);
  };

  const runUndo = async (student) => {
    setRowBusy(student.studentId);
    try {
      const res = await api.post(`/admin/class-management/students/${student.studentId}/undo`);
      toast.success(res.data.message);
      await Promise.all([openRoster(rosterFor), load()]);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not undo the move');
    } finally {
      setRowBusy(null);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (!overview) {
    return (
      <div className="empty-state">
        The class list could not be loaded.
        <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>Close and try again.</div>
      </div>
    );
  }

  const { classes, currentAcademicYear, nextAcademicYear, topLevelLabel, topLevelBasis } = overview;
  const promotable = classes.filter((c) => c.action !== 'none');

  return (
    <>
      {/* Where "the current year" came from. Shown rather than assumed, because the
          whole tab is built on it and an admin about to press a school-wide button
          deserves to see the basis. */}
      <div className="att-note" style={{ marginBottom: 'var(--sp-lg)' }}>
        <div>
          <strong>{currentAcademicYear?.label || 'No current academic year'}</strong>
          {' · '}
          promoting to <strong>{nextAcademicYear?.label || 'no following year'}</strong>
          {' · '}
          top level <strong>{topLevelLabel}</strong>
        </div>
        <div className="text-sm text-muted" style={{ marginTop: 4 }}>
          The top level — the one that graduates rather than moves up — is derived
          from {BASIS_TEXT[topLevelBasis] || 'the class list'}, not configured or typed in.
        </div>
      </div>

      {promotable.length === 0 ? (
        <div className="empty-state">
          No class currently holds any students.
          <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
            Admit students from the Students page, or record an earlier year with
            Enter Past Data.
          </div>
        </div>
      ) : (
        <div className="class-grid">
          {promotable.map((c) => (
            <div key={c.id} className="class-card">
              <div className="class-card-top">
                <div>
                  <div className="class-card-name">{c.label}</div>
                  <div className="class-card-count">
                    <Users size={13} /> {c.studentCount} student{c.studentCount === 1 ? '' : 's'}
                  </div>
                </div>
                <GraduationCap size={18} className="class-card-chevron" />
              </div>

              {/* The register count is this year's seats — a student moved
                  individually keeps their seat, so it does not fall when they
                  leave. "Remaining" is what still has to be decided, which is
                  the number the whole-class button will act on. */}
              {c.registerCount > 0 && (
                <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-xs)' }}>
                  {c.remainingCount} of {c.registerCount} still to move
                  {c.handledCount > 0 && ` · ${c.handledCount} already handled`}
                </div>
              )}

              <div style={{ marginTop: 'var(--sp-md)', display: 'flex', gap: 'var(--sp-sm)', flexWrap: 'wrap' }}>
                {c.action === 'promote' ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setPending({ mode: 'promote', cls: c })}
                    disabled={planLoading}
                    style={{ flex: 1 }}
                  >
                    Promote to {shortClassLabel(c.targetClassLabel)}
                    <ArrowRight size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => setPending({ mode: 'passout', cls: c })}
                    disabled={busy}
                    style={{ flex: 1 }}
                  >
                    Mark as Passed Out
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => openRoster(c)}
                  disabled={rosterLoading || busy}
                  title="Promote, keep or pass out individual students"
                >
                  <UserCog size={14} /> Students
                </button>
              </div>

              <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
                {c.action === 'promote' ? (
                  <>
                    into {c.targetClassLabel} for {nextAcademicYear?.label || 'the next year'}
                    {c.targetWillBeCreated && ' — the class does not exist yet and will be created'}
                  </>
                ) : (
                  /* The top level graduates. A level with no successor is a
                     different situation and needs a different sentence: the admin
                     can add a level, and is told so. */
                  c.noNextLevelReason === 'no_next_level'
                    ? `no next level to promote into — add one with "Add level" on the Students page, or pass these students out`
                    : 'these students leave the school'
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Confirmation ───────────────────────────────────────────────────
          Each action gets its own wording, because the two do genuinely
          different things and a shared "are you sure?" would hide that. */}
      {pending?.mode === 'promote' && (
        <ConfirmModal
          title={`Promote ${pending.cls.label}?`}
          confirmLabel="Continue to review"
          tone="primary"
          busy={planLoading}
          onClose={closePending}
          onConfirm={() => openPlan(pending.cls)}
        >
          <p>
            All <strong>{pending.cls.studentCount}</strong> student
            {pending.cls.studentCount === 1 ? '' : 's'} of {pending.cls.label} will move to{' '}
            <strong>{pending.cls.targetClassLabel}</strong> for {nextAcademicYear?.label}.
            {pending.cls.targetWillBeCreated && ' That class does not exist yet, so it will be created.'}
          </p>
          <ul className="confirm-list">
            <li>
              Everything recorded against {pending.cls.label} for {currentAcademicYear?.label}
              {' '}stays exactly as it is — attendance and marks remain tied to that
              class and that year, and stay readable in Class History.
            </li>
            <li>
              Fees are reset for the new year: the {currentAcademicYear?.label} fee record
              stays saved, and anything still unpaid on it becomes{' '}
              <strong>previous dues</strong> (tagged with {pending.cls.label}). The{' '}
              {nextAcademicYear?.label} fee starts blank — “not set”, not ₹0 —
              so the office enters the new amount deliberately.
            </li>
            <li>
              Roll numbers are cleared for the new year, so the office can assign the new
              register order freely without colliding with the old one.
            </li>
            <li>Nothing is deleted. Every student keeps every year of their record.</li>
          </ul>
          <p className="confirm-note">
            You will be asked to review all {pending.cls.studentCount} student
            {pending.cls.studentCount === 1 ? '' : 's'} before anything is moved.
          </p>
        </ConfirmModal>
      )}

      {pending?.mode === 'passout' && (
        <ConfirmModal
          title={`Mark ${pending.cls.label} as passed out?`}
          confirmLabel={`Graduate ${pending.cls.studentCount} student${pending.cls.studentCount === 1 ? '' : 's'}`}
          onClose={closePending}
          onConfirm={() => runPassOut(pending.cls)}
          busy={busy}
        >
          <p>
            All <strong>{pending.cls.studentCount}</strong> student
            {pending.cls.studentCount === 1 ? '' : 's'} of {pending.cls.label} will leave the
            school as <strong>passed out / alumni</strong>.
          </p>
          <ul className="confirm-list">
            <li>
              Nothing is deleted. Every year they attended — their attendance, marks and
              fees — stays saved and stays readable in Class History.
            </li>
            <li>
              {pending.cls.label} becomes empty, ready for the students promoted into it
              from the class below.
            </li>
            <li>
              They stop appearing on any current register, headcount or class list in the
              app, because no live class is held any more.
            </li>
          </ul>
          <p className="confirm-note">
            {pending.cls.label} is the highest class in the school, so there is no class
            above it to promote them into.
          </p>
        </ConfirmModal>
      )}

      {/* ── The review screen ──────────────────────────────────────────────
          Every student in the batch, with the identity that was checked. Rows
          needing a decision are marked and the action button stays disabled
          until every one of them has been answered. */}
      {plan && (
        <Modal
          wide
          title={`Review before promoting ${plan.sourceClass.label}`}
          onClose={() => { if (!busy) setPlan(null); }}
          footer={(
            <>
              <span className="text-sm text-muted" style={{ marginRight: 'auto' }}>
                {moving} student{moving === 1 ? '' : 's'} will move to{' '}
                {plan.targetClass?.label} for {plan.toAcademicYear?.label}
                {excluded.size ? ` · ${excluded.size} left behind` : ''}
              </span>
              <button className="btn btn-secondary" onClick={() => setPlan(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={guard(runPromote)}
                disabled={busy || cooling || unanswered.length > 0 || moving === 0}
                title={
                  unanswered.length
                    ? `Decide on: ${unanswered.map((u) => u.name).join(', ')}`
                    : undefined
                }
              >
                {busy ? 'Promoting…' : `Promote ${moving} student${moving === 1 ? '' : 's'}`}
              </button>
            </>
          )}
        >
          {plan.needsReviewCount === 0 ? (
            <div className="att-note ok" style={{ marginBottom: 'var(--sp-md)' }}>
              All {plan.totalStudents} records matched on name, guardian and contact, and
              nothing needs a decision. Review the list below, then promote.
            </div>
          ) : (
            <div className="att-note locked" style={{ marginBottom: 'var(--sp-md)' }}>
              <strong>{plan.needsReviewCount}</strong> of {plan.totalStudents} record
              {plan.totalStudents === 1 ? '' : 's'} need{plan.needsReviewCount === 1 ? 's' : ''}{' '}
              a decision before this batch can move. Confirm the ones that are correct, or
              leave the doubtful ones behind — nothing is decided automatically.
              {unanswered.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  Still to decide: {unanswered.map((u) => u.name).join(', ')}
                </div>
              )}
            </div>
          )}

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '32%' }}>Student</th>
                  <th>Guardian</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th style={{ width: 96 }}>Roll</th>
                  <th style={{ width: 190 }}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {plan.students.map((s) => {
                  const issues = flagText(s);
                  const isConfirmed = confirmed.has(s.studentId);
                  const isExcluded = excluded.has(s.studentId);
                  return (
                    <tr
                      key={s.studentId}
                      style={isExcluded ? { opacity: 0.5 } : undefined}
                    >
                      <td>
                        <div className="mk-saved-name">{s.name}</div>
                        {isExcluded && <span className="badge badge-muted">left behind</span>}
                      </td>
                      <td>{dash(s.identity.parentName)}</td>
                      <td>{dash(s.identity.guardianContact)}</td>
                      <td>
                        {issues.length === 0 ? (
                          <span className="badge badge-active">matched</span>
                        ) : (
                          issues.map((t) => (
                            <div key={t} className="text-sm" style={{ color: 'var(--red)' }}>
                              <TriangleAlert size={12} /> {t}
                            </div>
                          ))
                        )}
                      </td>
                      <td>{dash(s.rollNumber)}</td>
                      <td>
                        {s.needsReview ? (
                          <div className="mk-actions" style={{ margin: 0 }}>
                            <label className="mk-confirm-window">
                              <input
                                type="checkbox"
                                checked={isConfirmed}
                                disabled={isExcluded}
                                onChange={() => {
                                  toggleConfirm(s.studentId);
                                  // Confirming and leaving-behind are opposites; allowing
                                  // both at once would send a contradictory pair to the
                                  // server and leave the admin guessing which won.
                                  if (!isConfirmed) setExcluded((prev) => {
                                    const n = new Set(prev); n.delete(s.studentId); return n;
                                  });
                                }}
                              />
                              Confirm
                            </label>
                            <label className="mk-confirm-window">
                              <input
                                type="checkbox"
                                checked={isExcluded}
                                disabled={isConfirmed}
                                onChange={() => {
                                  toggleExclude(s.studentId);
                                  if (!isExcluded) setConfirmed((prev) => {
                                    const n = new Set(prev); n.delete(s.studentId); return n;
                                  });
                                }}
                              />
                              Leave behind
                            </label>
                          </div>
                        ) : (
                          <span className="text-sm text-muted">no decision needed</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {plan.needsReviewCount > 0 && (
            <div className="mk-actions" style={{ marginTop: 'var(--sp-md)' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setConfirmed(new Set(plan.students.filter((s) => s.needsReview).map((s) => s.studentId)));
                  setExcluded(new Set());
                }}
              >
                Confirm all {plan.needsReviewCount} flagged
              </button>
              <span className="text-sm text-muted">
                An explicit shortcut for a class you have just read — not an automatic
                resolution.
              </span>
            </div>
          )}

          <div className="info-note" style={{ marginTop: 'var(--sp-md)' }}>
            Checked against every other record in the school on name, guardian name and
            guardian contact — the same three fields the office types from a paper
            register. Roll numbers are deliberately not used: they are reassigned every
            year, so two records sharing one proves nothing.
          </div>
        </Modal>
      )}

      {/* ── Per-student roster ────────────────────────────────────────────
          Every child in this year's register for the class, including the ones
          already moved (badged, buttons disabled), so the list never silently
          shrinks and a second move is impossible from here. */}
      {rosterFor && (
        <Modal
          wide
          title={`${roster?.label || rosterFor.label} — students`}
          onClose={closeRoster}
          footer={(
            <button className="btn btn-secondary" onClick={closeRoster} disabled={Boolean(rowBusy)}>
              Close
            </button>
          )}
        >
          {rosterLoading || !roster ? (
            <div className="loading-center"><div className="spinner" /></div>
          ) : (
            <>
              <div className="att-note" style={{ marginBottom: 'var(--sp-md)' }}>
                <div>
                  {roster.fromAcademicYear.label} register: <strong>{roster.totalCount}</strong>{' '}
                  student{roster.totalCount === 1 ? '' : 's'} · {roster.handledCount} already
                  handled · <strong>{roster.remainingCount}</strong> remaining
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  {roster.targetClass
                    ? `Each student can be promoted to a class you choose, or kept in ${roster.label} to repeat the year.`
                    : roster.isTop
                      ? 'This is the top class — its students graduate rather than move up, so each row can be kept back to repeat the year, or passed out.'
                      : `${roster.label} has no next level to promote into, so each student can be kept back or passed out. Add the next level on the Students page if the year is not really the last.`}
                </div>
              </div>

              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '26%' }}>Student</th>
                      <th>Guardian</th>
                      <th>Contact</th>
                      <th>Status</th>
                      <th style={{ width: 240 }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.students.map((s) => (
                      <tr key={s.studentId}>
                        <td>
                          <div className="mk-saved-name">{s.name}</div>
                          <div className="text-sm text-muted">Roll {dash(s.rollNumber)}</div>
                        </td>
                        <td>{dash(s.parentName)}</td>
                        <td>{dash(s.guardianContact)}</td>
                        <td>
                          {s.state === 'active'
                            ? <span className="badge badge-muted">In this class</span>
                            : (
                              <span className={`badge ${s.state === 'passed_out' ? 'badge-danger' : 'badge-active'}`}>
                                {s.stateLabel}
                              </span>
                            )}
                          {s.undoBlock && (
                            <div className="text-sm text-muted" style={{ marginTop: 4 }}>{s.undoBlock}</div>
                          )}
                        </td>
                        <td>
                          {s.handled ? (
                            s.canUndo ? (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => runUndo(s)}
                                disabled={rowBusy === s.studentId}
                              >
                                <RotateCcw size={13} /> {rowBusy === s.studentId ? 'Undoing…' : 'Undo'}
                              </button>
                            ) : (
                              <span className="text-sm text-muted">Cannot be undone</span>
                            )
                          ) : (
                            <div className="mk-actions" style={{ margin: 0 }}>
                              {/* One button, always. It used to be a pair —
                                  "Promote to 6A" and "Keep in 5A" — which made the
                                  destination a fact computed elsewhere rather than a
                                  choice. The popup asks which class, and picks the
                                  right server action from the answer. A row where the
                                  class simply has no successor (the top level) still
                                  has something to offer: repeating the year is one of
                                  the options inside, so the button is not hidden. */}
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => setPromoteStudent(s)}
                                disabled={rowBusy === s.studentId}
                              >
                                Promote
                              </button>
                              {!roster.targetClass && (
                                <button
                                  type="button"
                                  className="btn btn-danger btn-sm"
                                  onClick={() => setPendingMove({ cls: rosterFor, student: s, action: 'pass_out' })}
                                  disabled={rowBusy === s.studentId}
                                >
                                  Pass Out
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="info-note" style={{ marginTop: 'var(--sp-md)' }}>
                A student already moved keeps their seat in this year's register and stays
                listed above, badged, so nobody can be moved twice in one cycle. The Undo
                offer closes as soon as attendance, marks or a fee payment exists for the
                new year.
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ── Confirmation for one student's pass-out ───────────────────────
          Promote and repeat-the-year now open the popup below, which shows the
          destination; this remains only for the one action that needs no choice. */}
      {pendingMove && (
        <ConfirmModal
          title={`Mark ${pendingMove.student.name} as passed out?`}
          confirmLabel="Mark as passed out"
          tone="danger"
          busy={rowBusy === pendingMove.student.studentId}
          onClose={() => { if (!rowBusy) setPendingMove(null); }}
          onConfirm={runMove}
        >
          <p>
            <strong>{pendingMove.student.name}</strong> will leave{' '}
            <strong>{pendingMove.cls.label}</strong> as <strong>passed out / alumni</strong>.
          </p>
          <ul className="confirm-list">
            <li>Nothing is deleted — attendance, marks and fees stay readable in Class History.</li>
            <li>Any fee still unpaid on their record remains as <strong>previous dues</strong>.</li>
            <li>They stop appearing on any current register, headcount or class list.</li>
          </ul>
        </ConfirmModal>
      )}

      {/* ── The Promote popup ─────────────────────────────────────────────
          Asks WHERE the child is going, from the options the server derives.
          Opened from a roster row; stacked above the roster modal so the list
          stays visible behind it. */}
      {promoteStudent && (
        <PromoteStudentModal
          student={promoteStudent}
          onClose={() => { if (!rowBusy) setPromoteStudent(null); }}
          onDone={finishPromote}
        />
      )}
    </>
  );
}