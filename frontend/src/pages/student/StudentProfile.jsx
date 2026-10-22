import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { User, Phone, MapPin, Info, Banknote } from 'lucide-react';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';
import FeeLedgerTable from '../../components/FeeLedgerTable';

export default function StudentProfile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/students/${user.linkedEntityId}/profile`)
      .then((r) => setProfile(r.data.data))
      .catch(fail)
      .finally(() => setLoading(false));
  }, [user, reloadKey, fail, setLoading]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (error) {
    return (
      <LoadErrorState
        title="My Profile"
        subtitle="Your personal information"
        detail={error}
        onRetry={retry}
        icon={User}
      />
    );
  }

  const initials = profile?.name?.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || '?';

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">My Profile</div>
        <div className="page-subtitle">Your personal information</div>
      </div>

      {profile && (
        <>
          {/* Avatar + name */}
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-lg)', marginBottom: 'var(--sp-lg)' }}>
            <div style={{
              width: 80, height: 80, borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--clr-primary), var(--clr-accent))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 32, fontWeight: 800, flexShrink: 0,
              boxShadow: 'var(--shadow-glow)'
            }}>
              {initials}
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{profile.name}</div>
              <div style={{ color: 'var(--clr-text-muted)', marginTop: 4 }}>
                {/* The class's display name from the shared function, so a named
                    level reads "Nursery A" rather than "-2-A". */}
                {profile.classLabel || '—'} &nbsp;·&nbsp; Roll No: {profile.rollNumber || '—'}
              </div>
              <div style={{ marginTop: 6 }}>
                <span className="badge badge-active">Active Student</span>
              </div>
            </div>
          </div>

          {/* Personal details */}
          <div className="section">
            <div className="section-title"><User size={14} /> Personal Information</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Full Name</span><span className="info-value">{profile.name}</span></div>
                <div className="info-item"><span className="info-label">Date of Birth</span><span className="info-value">{profile.dob}</span></div>
                <div className="info-item"><span className="info-label">Blood Group</span><span className="info-value">{profile.bloodGroup}</span></div>
                <div className="info-item"><span className="info-label">Admission Year</span><span className="info-value">{profile.admissionYear}</span></div>
              </div>
            </div>
          </div>

          {/* Guardian details */}
          <div className="section">
            <div className="section-title"><Phone size={14} /> Guardian Information</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Parent / Guardian</span><span className="info-value">{profile.parentName}</span></div>
                <div className="info-item"><span className="info-label">Contact Number</span><span className="info-value">{profile.guardianContact}</span></div>
                <div className="info-item" style={{ gridColumn: '1 / -1' }}>
                  <span className="info-label"><MapPin size={12} style={{ display: 'inline' }} /> Address</span>
                  <span className="info-value">{profile.address}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Fee details — the same ledger the school office reads, so a parent can
              see WHICH year an amount belongs to rather than a single unexplained
              total. Read-only: a student never edits their own fee. */}
          <div className="section">
            <div className="section-title"><Banknote size={14} /> Fee Details</div>
            <FeeSection studentId={user?.linkedEntityId} />
          </div>

          {/* Read-only note */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--sp-sm)',
            background: 'var(--tint-oxblood)', border: '1px solid var(--tint-oxblood)',
            borderRadius: 'var(--r-sm)', padding: '10px var(--sp-md)',
            fontSize: 13, color: 'var(--clr-text-muted)'
          }}>
            <Info size={14} style={{ color: 'var(--clr-primary-h)', flexShrink: 0 }} />
            Contact your school administrator to update any profile details.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * FeeSection — the student's own fee ledger, read-only.
 *
 * Uses the shared `FeeLedgerTable`, so what a parent sees beside what the office
 * sees is the same rows and the same payments, down to which class and year each
 * payment settled. Read straight from the fee records: nothing here is typed in,
 * and a failure to load is reported rather than shown as an empty ledger.
 */
function FeeSection({ studentId }) {
  const [ledger, setLedger] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!studentId) return;
    let alive = true;
    setLoading(true);
    api.get(`/students/${studentId}/fees`)
      .then((r) => {
        if (!alive) return;
        setLedger(r.data.data);
        setError('');
      })
      .catch((err) => {
        if (!alive) return;
        setError(err.response?.data?.message || 'Could not load your fee details.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [studentId]);

  if (loading) {
    return (
      <div className="card">
        <div className="loading-center"><div className="spinner" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <LoadErrorState compact detail={error} onRetry={() => setLedger(null)} icon={Banknote} />
      </div>
    );
  }

  const outstanding = Number(ledger?.outstanding || 0);

  return (
    <div className="card">
      <div className="info-grid" style={{ marginBottom: 'var(--sp-md)' }}>
        <div className="info-item">
          <span className="info-label">Total outstanding</span>
          <span className="info-value">
            <b>{`₹${outstanding.toLocaleString('en-IN')}`}</b>
          </span>
        </div>
        <div className="info-item">
          <span className="info-label">Current year</span>
          <span className="info-value">
            {ledger?.rows?.find((r) => r.isCurrent)?.isSet
              ? `₹${Number(ledger.rows.find((r) => r.isCurrent).paid || 0).toLocaleString('en-IN')} paid`
              : 'Fee not set'}
          </span>
        </div>
      </div>

      <FeeLedgerTable
        rows={ledger?.rows || []}
        currentAcademicYearId={ledger?.currentAcademicYearId}
        showPayments
        title="Every year, what was charged, what has been paid, and what it covered"
      />

      <div className="info-note" style={{ marginTop: 'var(--sp-md)' }}>
        Each year is kept on its own record, and every payment is shown against the year
        and class it paid. If you believe a figure is wrong, contact the school office.
      </div>
    </div>
  );
}
