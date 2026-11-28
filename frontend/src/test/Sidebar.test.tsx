import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Layout } from 'antd';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar from '../components/Sidebar';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'admin-1',
      username: 'admin',
      fullName: 'Quản trị viên',
      role: 'ADMIN',
      companyScope: true,
      branches: [],
      grants: [],
      permissions: [
        'orders.read',
        'vehicles.read',
        'trips.plan',
        'settings.read',
        'accounts.manage',
      ],
    },
    can: () => true,
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

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('Sidebar collapsible navigation', () => {
  it('toggles collapsed state, persists to localStorage, and restores on remount', () => {
    const onSelectTab = vi.fn();
    const { container, unmount } = render(
      <Layout>
        <Sidebar currentTab="dispatch-auto" onSelectTab={onSelectTab} />
      </Layout>,
    );

    const sider = container.querySelector('.tms-sidebar');
    expect(sider).not.toHaveClass('ant-layout-sider-collapsed');
    expect(screen.getByText('Danh mục chức năng')).toBeInTheDocument();
    expect(screen.getByText('Hệ thống trực tuyến')).toBeInTheDocument();

    const collapseBtn = screen.getByRole('button', { name: 'Thu gọn thanh điều hướng' });
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(collapseBtn);

    expect(sider).toHaveClass('ant-layout-sider-collapsed');
    expect(screen.queryByText('Danh mục chức năng')).not.toBeInTheDocument();
    expect(screen.queryByText('Hệ thống trực tuyến')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('tms_sidebar_collapsed')).toBe('true');

    const expandBtn = screen.getByRole('button', { name: 'Mở rộng thanh điều hướng' });
    expect(expandBtn).toHaveAttribute('aria-expanded', 'false');

    unmount();

    const remount = render(
      <Layout>
        <Sidebar currentTab="dispatch-auto" onSelectTab={onSelectTab} />
      </Layout>,
    );
    expect(remount.container.querySelector('.tms-sidebar')).toHaveClass('ant-layout-sider-collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Mở rộng thanh điều hướng' }));
    expect(remount.container.querySelector('.tms-sidebar')).not.toHaveClass(
      'ant-layout-sider-collapsed',
    );
    expect(window.localStorage.getItem('tms_sidebar_collapsed')).toBe('false');
  });
});
