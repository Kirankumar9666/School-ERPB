import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { User, Phone, MapPin, Info } from 'lucide-react';

export default function StudentProfile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/students/${user.linkedEntityId}/profile`)
      .then((r) => setProfile(r.data.data))
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

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
                Class {profile.class}-{profile.section} &nbsp;·&nbsp; Roll No: {profile.rollNumber}
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

          {/* Read-only note */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--sp-sm)',
            background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
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
