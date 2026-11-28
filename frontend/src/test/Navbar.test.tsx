import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Navbar from '../components/Navbar';

const mockLogout = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u-1',
      username: 'admin',
      fullName: 'Quản trị viên',
      role: 'ADMIN',
      companyScope: true,
      branches: [{ id: 'branch-1', code: 'HAN', name: 'Chi nhánh Hà Nội' }],
      grants: [{ role: 'ADMIN', scopeType: 'COMPANY', branchId: null, permissions: [] }],
    },
    logout: mockLogout,
    branchId: 'branch-1',
    setBranchId: vi.fn(),
  }),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Navbar', () => {
  it('does not render the branch selector in the top header and preserves user actions', () => {
    render(<Navbar />);

    expect(screen.getByText('TMS LOGISTICS')).toBeInTheDocument();
    expect(screen.queryByLabelText('Chi nhánh làm việc')).not.toBeInTheDocument();
    expect(screen.getByText('Quản trị viên')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Đăng xuất' }));
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});
