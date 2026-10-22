import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import { resetRemindersCache } from '../utils/remindersCache';

const AuthContext = createContext(null);

/**
 * AuthProvider wraps the app and provides auth state + actions.
 * Components consume via useAuth() hook — never access localStorage directly.
 */
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On app mount, restore session from localStorage
  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    const token = localStorage.getItem('accessToken');
    if (storedUser && token) {
      setUser(JSON.parse(storedUser));
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (username, password) => {
    const { data } = await api.post('/auth/login', { username, password });
    const { accessToken, refreshToken, user: userData } = data.data;

    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('user', JSON.stringify(userData));
    // A fresh login starts with an empty reminders cache, so nothing from a
    // previous session on this device can be shown to the new user.
    resetRemindersCache();
    setUser(userData);
    return userData;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    // Drop the cached reminders so the next user never sees this one's list.
    resetRemindersCache();
    setUser(null);
  }, []);

  /**
   * Change the signed-in user's OWN password — the only way out of the forced
   * first-login state (user.mustChangePassword) that student accounts are
   * created in. The server replies with a freshly signed access token whose
   * flag is already cleared plus the sanitized user shape, so both are swapped
   * in together and the app unblocks on the spot. No password is ever written
   * to storage, and only the caller of this function ever holds one.
   */
  const changePassword = useCallback(async (currentPassword, newPassword) => {
    const { data } = await api.post('/auth/change-password', { currentPassword, newPassword });
    const { accessToken, user: userData } = data.data;

    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(userData);
    return userData;
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, login, logout, changePassword, loading, isAuthenticated: !!user }}
    >
      {children}
    </AuthContext.Provider>
  );
};

/** Hook to consume auth context */
export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
