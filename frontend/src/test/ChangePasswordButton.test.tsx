import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import ChangePasswordButton from '../components/ChangePasswordButton';

const changePassword = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ authApi: { changePassword }, apiErrorMessage: () => 'Không thể đổi mật khẩu' }));
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('preserves form on network failure; successful retry invalidates session and clears secrets', async () => {
  changePassword.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ data: { changed: true } });
  const revoked = vi.fn();
  window.addEventListener('tms:unauthorized', revoked);
  try {
    render(<ChangePasswordButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Đổi mật khẩu' }));
    fireEvent.change(screen.getByLabelText('Mật khẩu hiện tại'), { target: { value: 'current-password' } });
    fireEvent.change(screen.getByLabelText('Mật khẩu mới'), { target: { value: 'new-password-valid' } });
    fireEvent.change(screen.getByLabelText('Xác nhận mật khẩu mới'), { target: { value: 'new-password-valid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Đổi mật khẩu và đăng xuất' }));
    await screen.findByText('Không thể đổi mật khẩu');
    expect(screen.getByLabelText('Mật khẩu hiện tại')).toHaveValue('current-password');
    expect(revoked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Đổi mật khẩu và đăng xuất' }));
    await waitFor(() => expect(revoked).toHaveBeenCalledTimes(1));
    expect(changePassword).toHaveBeenLastCalledWith('current-password', 'new-password-valid');
    fireEvent.click(screen.getByRole('button', { name: 'Đổi mật khẩu' }));
    expect(screen.getByLabelText('Mật khẩu hiện tại')).toHaveValue('');
  } finally { window.removeEventListener('tms:unauthorized', revoked); }
}, 20000);
