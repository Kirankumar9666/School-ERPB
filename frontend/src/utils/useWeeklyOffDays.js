import { useEffect, useState } from 'react';
import api from '../services/api';

/**
 * The school's weekly off days — ONE setting read from `/school/settings` and
 * shared by every attendance calendar. Default [0] (Sunday only) until the real
 * setting arrives, so a calendar can never paint a wrong weekend in the gap.
 *
 * A module-level promise cache means the whole app makes one request per
 * session; `setWeeklyOffDays` (called after the admin saves) updates the cache
 * and notifies every mounted calendar so they re-render immediately.
 */
export const DEFAULT_WEEKLY_OFF_DAYS = [0];

const EVENT = 'school-weekly-off-days';
let cached = null;
let inflight = null;

const fetchWeeklyOffDays = () => {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api.get('/school/settings')
      .then((res) => {
        const days = res.data?.data?.weeklyOffDays;
        cached = Array.isArray(days) ? days : DEFAULT_WEEKLY_OFF_DAYS;
        return cached;
      })
      .catch(() => DEFAULT_WEEKLY_OFF_DAYS)
      .finally(() => { inflight = null; });
  }
  return inflight;
};

/** Read the setting; re-renders when an admin saves a new value. */
export const useWeeklyOffDays = () => {
  const [days, setDays] = useState(cached || DEFAULT_WEEKLY_OFF_DAYS);
  useEffect(() => {
    let alive = true;
    const onChange = (e) => { if (alive) setDays(e.detail); };
    window.addEventListener(EVENT, onChange);
    fetchWeeklyOffDays().then((d) => { if (alive) setDays(d); });
    return () => { alive = false; window.removeEventListener(EVENT, onChange); };
  }, []);
  return days;
};

/** Called after the admin saves — refreshes the cache and live calendars. */
export const setWeeklyOffDays = (days) => {
  const value = Array.isArray(days) ? days : DEFAULT_WEEKLY_OFF_DAYS;
  cached = value;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
};

/** Weekday number (0 = Sunday) for a 'YYYY-MM-DD' date, in local time. */
export const weekdayOfISO = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getDay();
};
