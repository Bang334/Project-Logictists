import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../api/client';
import { AuthProvider, useAuth } from '../context/AuthContext';

vi.mock('../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/client')>();
  return {
    ...original,
    authApi: {
      login: vi.fn(),
      getProfile: vi.fn(),
      logout: vi.fn().mockResolvedValue({}),
    },
  };
});
vi.mock('../api/realtime', () => ({ disconnectRealtimeSocket: vi.fn() }));

const adminProfile = {
  id: 'admin-1',
  username: 'admin',
  fullName: 'Admin',
  role: 'ADMIN',
  branchId: null,
  companyScope: true,
  permissions: ['trips.plan'],
  branches: [
    { id: 'branch-hn', code: 'HN', name: 'Hà Nội' },
    { id: 'branch-dad', code: 'DAD', name: 'Đà Nẵng' },
  ],
  grants: [{ role: 'ADMIN', scopeType: 'COMPANY', branchId: null, permissions: ['trips.plan'] }],
};

function Probe() {
  const { branchId, setBranchId, logout, loading } = useAuth();
  if (loading) return <span>loading</span>;
  return (
    <div>
      <output aria-label="branch">{branchId ?? 'ALL'}</output>
      <button onClick={() => setBranchId('branch-dad')}>pick-dad</button>
      <button onClick={() => setBranchId(undefined)}>pick-all</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('AuthContext branch persistence', () => {
  it('restores selected branchId across reload in sessionStorage and clears on ALL or logout', async () => {
    sessionStorage.setItem('tms_token', 'token-1');
    vi.mocked(authApi.getProfile).mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: adminProfile,
    });

    const { unmount } = render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByLabelText('branch')).toHaveTextContent('ALL'));

    fireEvent.click(screen.getByText('pick-dad'));
    expect(screen.getByLabelText('branch')).toHaveTextContent('branch-dad');
    expect(sessionStorage.getItem('tms_branch_id')).toBe('branch-dad');

    unmount();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByLabelText('branch')).toHaveTextContent('branch-dad'));

    fireEvent.click(screen.getByText('pick-all'));
    expect(screen.getByLabelText('branch')).toHaveTextContent('ALL');
    expect(sessionStorage.getItem('tms_branch_id')).toBeNull();

    fireEvent.click(screen.getByText('pick-dad'));
    expect(sessionStorage.getItem('tms_branch_id')).toBe('branch-dad');
    fireEvent.click(screen.getByText('logout'));
    await waitFor(() => expect(sessionStorage.getItem('tms_branch_id')).toBeNull());
  });
});
