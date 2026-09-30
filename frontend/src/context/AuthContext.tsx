import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { User, parseUser } from '../types';
import { authApi, resetRequests, setApiSession, apiErrorMessage } from '../api/client';

interface AuthContextType {
  user: User | null; token: string | null; loading: boolean; error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>; retry: () => Promise<void>;
  branchId?: string; setBranchId: (id?: string) => void;
  can: (permission: string) => boolean; scopeVersion: number;
}
const AuthContext = createContext<AuthContextType | undefined>(undefined);
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(sessionStorage.getItem('tms_token'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [branchId, setBranch] = useState<string>();
  const [scopeVersion, setScopeVersion] = useState(0);
  const operation = useRef(0);
  const userRef = useRef<User | null>(null);
  const branchRef = useRef<string>();
  const invalidate = () => { resetRequests(); setScopeVersion(v => v + 1); };
  const clear = () => {
    operation.current++; invalidate(); sessionStorage.removeItem('tms_token');
    localStorage.removeItem('tms_token'); setApiSession(null);
    setToken(null); setUser(null); userRef.current = null; setBranch(undefined); branchRef.current = undefined; setLoading(false);
  };
  const acceptProfile = (profile: User) => {
    if (JSON.stringify(userRef.current) !== JSON.stringify(profile)) invalidate();
    userRef.current = profile; setUser(profile);
    let next = branchRef.current;
    if (next && !profile.branches.some(b => b.id === next)) next = undefined;
    if (!next && !profile.companyScope && profile.branches.length === 1) next = profile.branches[0].id;
    branchRef.current = next; setBranch(next);
    setApiSession(sessionStorage.getItem('tms_token'), next);
  };
  const retry = async () => {
    const saved = sessionStorage.getItem('tms_token');
    if (!saved) { setLoading(false); return; }
    const seq = ++operation.current;
    setError(null); setLoading(true); setApiSession(saved, branchRef.current);
    try {
      const response = await authApi.getProfile();
      if (seq === operation.current) acceptProfile(parseUser(response.data));
    } catch (e) {
      if (seq === operation.current) { setError(apiErrorMessage(e)); setUser(null); }
    } finally { if (seq === operation.current) setLoading(false); }
  };
  useEffect(() => {
    localStorage.removeItem('tms_token');
    void retry();
    const invalid = () => { clear(); setError('Phiên đã hết hạn, bị thu hồi hoặc tài khoản đã bị khóa. Vui lòng đăng nhập lại.'); };
    window.addEventListener('tms:unauthorized', invalid);
    return () => { window.removeEventListener('tms:unauthorized', invalid); };
  }, []);
  useEffect(() => {
    if (!token || !user) return;
    let disposed = false;
    const refresh = async () => {
      const seq = operation.current;
      try {
        const response = await authApi.getProfile();
        if (!disposed && seq === operation.current) acceptProfile(parseUser(response.data));
      } catch (e) {
        if (!disposed && seq === operation.current) { invalidate(); setUser(null); setError(apiErrorMessage(e)); }
      }
    };
    const timer = window.setInterval(() => void refresh(), 30000);
    const focus = () => void refresh();
    const forbidden = () => { setError('Bạn không có quyền thực hiện thao tác này trong phạm vi hiện tại.'); void refresh(); };
    window.addEventListener('focus', focus);
    window.addEventListener('tms:forbidden', forbidden);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('tms:forbidden', forbidden); };
  }, [token, !!user]);
  const login = async (username: string, password: string) => {
    clear(); setError(null);
    const seq = ++operation.current;
    const response = await authApi.login(username, password);
    const profile = parseUser(response.data.user);
    if (typeof response.data.accessToken !== 'string') throw new Error('Phản hồi phiên không hợp lệ');
    if (seq !== operation.current) return;
    sessionStorage.setItem('tms_token', response.data.accessToken);
    setToken(response.data.accessToken); setApiSession(response.data.accessToken); acceptProfile(profile);
  };
  const logout = async () => {
    // Start revocation with the current bearer token before clearing the protected UI.
    const pending = authApi.logout();
    clear(); setError(null);
    const seq = operation.current;
    try { await pending; } catch { if (seq === operation.current) setError('Đã xóa phiên trên trình duyệt; chưa xác nhận thu hồi tại server do lỗi kết nối. Token còn hiệu lực tới khi hết hạn.'); }
  };
  const setBranchId = (id?: string) => {
    if (id && !userRef.current?.branches.some(b => b.id === id)) return;
    invalidate(); branchRef.current = id; setBranch(id); setApiSession(sessionStorage.getItem('tms_token'), id);
  };
  const can = (permission: string) => !!user?.grants.some(g => g.permissions.includes(permission) && (g.scopeType === 'COMPANY' || !branchId || g.branchId === branchId));
  return <AuthContext.Provider value={{ user, token, login, logout, loading, error, retry, branchId, setBranchId, can, scopeVersion }}>{children}</AuthContext.Provider>;
};
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
