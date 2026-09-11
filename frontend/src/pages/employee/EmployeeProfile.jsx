import { useEffect, useState } from 'react';
import { User, Briefcase, Phone, MapPin, Info, IdCard } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { initials } from '../../utils/date';

/**
 * Employee Profile — personal + professional details (read-only for employee).
 */
export default function EmployeeProfile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/employees/${user.linkedEntityId}/profile`)
      .then((r) => setProfile(r.data.data))
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">My Profile</div>
        <div className="page-subtitle">Your employment record</div>
      </div>

      {profile && (
        <>
          {/* Header card */}
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-lg)', marginBottom: 'var(--sp-xl)' }}>
            <div style={{
              width: 80, height: 80, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, var(--clr-primary), var(--clr-accent))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 30, fontWeight: 800, boxShadow: 'var(--shadow-glow)',
            }}>
              {initials(profile.name)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{profile.name}</div>
              <div style={{ color: 'var(--clr-text-muted)', marginTop: 4 }}>
                {profile.employeeId} &nbsp;·&nbsp; {profile.designation} · {profile.department}
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 'var(--sp-sm)', alignItems: 'center' }}>
                <span className={`badge ${profile.status === 'active' ? 'badge-active' : 'badge-pending'}`}>
                  {profile.status || 'active'}
                </span>
                <span className={`badge badge-${profile.role}`}>{profile.role}</span>
              </div>
            </div>
          </div>

          {/* Personal */}
          <div className="section">
            <div className="section-title"><User size={14} /> Personal Information</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Employee ID</span><span className="info-value">{profile.employeeId}</span></div>
                <div className="info-item"><span className="info-label">Gender</span><span className="info-value">{profile.gender}</span></div>
                <div className="info-item"><span className="info-label">Date of Birth</span><span className="info-value">{profile.dob}</span></div>
                <div className="info-item"><span className="info-label">Blood Group</span><span className="info-value">{profile.bloodGroup}</span></div>
                <div className="info-item"><span className="info-label"><Phone size={11} style={{ display: 'inline' }} /> Mobile</span><span className="info-value">{profile.mobile}</span></div>
                <div className="info-item"><span className="info-label">Email</span><span className="info-value">{profile.email}</span></div>
                <div className="info-item" style={{ gridColumn: '1 / -1' }}>
                  <span className="info-label"><MapPin size={11} style={{ display: 'inline' }} /> Address</span>
                  <span className="info-value">{profile.address}</span>
                </div>
                <div className="info-item"><span className="info-label">Emergency Contact</span><span className="info-value">{profile.emergencyContact}</span></div>
              </div>
            </div>
          </div>
{/* Professional */}
          <div className="section">
            <div className="section-title"><Briefcase size={14} /> Professional Information</div>
            <div className="card">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">Department</span><span className="info-value">{profile.department}</span></div>
                <div className="info-item"><span className="info-label">Designation</span><span className="info-value">{profile.designation}</span></div>
                <div className="info-item"><span className="info-label">Qualification</span><span className="info-value">{profile.qualification}</span></div>
                <div className="info-item"><span className="info-label">Date of Joining</span><span className="info-value">{profile.dateOfJoining}</span></div>
                <div className="info-item"><span className="info-label">Experience</span><span className="info-value">{profile.experience}</span></div>
                <div className="info-item"><span className="info-label">Reporting Principal</span><span className="info-value">{profile.reportingPrincipal}</span></div>
                <div className="info-item"><span className="info-label">Employment Type</span><span className="info-value">{profile.employmentType}</span></div>
                <div className="info-item"><span className="info-label"><IdCard size={11} style={{ display: 'inline' }} /> Employee ID</span><span className="info-value">{profile.employeeId}</span></div>
              </div>
            </div>
          </div>

          {/* Note */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--sp-sm)',
            background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
            borderRadius: 'var(--r-sm)', padding: '10px var(--sp-md)', fontSize: 13,
            color: 'var(--clr-text-muted)',
          }}>
            <Info size={14} style={{ color: 'var(--clr-primary-h)', flexShrink: 0 }} />
            Contact your school administrator to update any profile details.
          </div>
        </>
      )}
    </div>
  );
}