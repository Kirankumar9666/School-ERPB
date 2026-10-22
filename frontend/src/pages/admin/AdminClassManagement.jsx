import { useCallback, useEffect, useState } from 'react';
import ClassManagementPromote from '../../components/ClassManagementPromote';
import ClassManagementHistory from '../../components/ClassManagementHistory';
import ClassManagementPastData from '../../components/ClassManagementPastData';
import api from '../../services/api';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';

/**
 * Class Management — promote a class to the next grade, read back what a class
 * looked like in an earlier year, and type in a year the school never recorded
 * live.
 *
 * ## Why a page rather than three
 *
 * All three answer the same underlying question — *which class was this child in,
 * and when* — from the one `StudentEnrollment` table. Splitting them across
 * separate pages would mean three places to explain that a student's class is a
 * per-year fact rather than a single current value, and three chances to get the
 * year selector subtly different. They share the academic-year list, so it is
 * fetched once here and handed down.
 *
 * ## Admin-only
 *
 * The route is registered inside the `/admin` ProtectedLayout, which allows
 * `ROLES.ADMIN` only, and the backend's own router gates every
 * `/class-management/*` endpoint the same way. Both halves matter: the layout
 * keeps teachers out of the UI, the server keeps them out of the data. Nothing
 * here is offered to the Employee Portal — a teacher has no business moving a
 * whole class up a grade.
 *
 * ## Nothing is hardcoded
 *
 * The tabs read every list from the API: which year is current, which class is
 * the top grade, which classes ran in a given year, who was in them. A school
 * with grades 1–4 and one with 1–12 both work, and neither the page nor the
 * components below contain a class name, a grade number or a year.
 *
 * @param {object} props
 * @param {Array}  props.years  every academic year, newest first
 * @param {boolean} props.loading
 */
export default function AdminClassManagement() {
  const [tab, setTab] = useState('promote'); // 'promote' | 'history' | 'pastdata'
  const [years, setYears] = useState([]);
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();

  const loadYears = useCallback(async () => {
    try {
      const res = await api.get('/admin/class-management/years');
      setYears(res.data.data || []);
    } catch (err) {
      /* Leaving `years` at [] here read as "the school has no academic years" —
         record why the read failed so the page can say so instead. */
      fail(err);
    } finally {
      setLoading(false);
    }
  }, [fail, setLoading]);

  useEffect(() => { loadYears(); }, [loadYears, reloadKey]);

  const TABS = [
    { id: 'promote', label: 'Promote Classes' },
    { id: 'history', label: 'Class History' },
    { id: 'pastdata', label: 'Enter Past Data' },
  ];

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Class Management</div>
        <div className="page-subtitle">
          Move classes up a grade, look back at earlier years, and record years the
          school never entered live
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab-btn${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : error ? (
        /* Every tab below reads `years`, so a failed year list would render as
           "no academic years exist" — the failure takes the content slot with
           its own message and a retry instead. */
        <LoadErrorState detail={error} onRetry={retry} />
      ) : (
        /* key={tab} remounts the tab on a switch, so a class left selected in one
           tab can never be silently applied to another. */
        <>
          {tab === 'promote' && <ClassManagementPromote key="promote" />}
          {tab === 'history' && <ClassManagementHistory key="history" years={years} />}
          {tab === 'pastdata' && <ClassManagementPastData key="pastdata" years={years} />}
        </>
      )}
    </div>
  );
}