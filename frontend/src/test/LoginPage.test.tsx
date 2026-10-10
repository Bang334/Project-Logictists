import React from 'react';
import { App as AntdApp } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import LoginPage from '../pages/LoginPage';

const authMocks = vi.hoisted(() => ({
  login: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login: authMocks.login }),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  authMocks.login.mockReset();
});

describe('LoginPage', () => {
  it('requires explicit credentials and submits them', async () => {
    render(
      <AntdApp>
        <LoginPage />
      </AntdApp>,
    );

    expect(screen.getByLabelText('Tên đăng nhập')).toHaveValue('');
    expect(screen.getByLabelText('Mật khẩu')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Tên đăng nhập'), { target: { value: 'test-user' } });
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    await waitFor(() => {
      expect(authMocks.login).toHaveBeenCalledWith('test-user', 'test-password');
    });
  });
});
