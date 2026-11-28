import { canOpenTab } from '../utils/navigationAccess';

import React, { useState } from 'react';
import { Button, Layout, Menu, Tooltip } from 'antd';
import {
  CarOutlined,
  CompassOutlined,
  DashboardOutlined,
  InboxOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Sider } = Layout;
const SIDEBAR_STORAGE_KEY = 'tms_sidebar_collapsed';

function readStoredCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // Ignore storage read errors in restricted contexts.
  }
  return null;
}

interface SidebarProps {
  currentTab: string;
  onSelectTab: (key: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab }) => {
  const { can, user } = useAuth();
  const [collapsed, setCollapsed] = useState<boolean>(() => readStoredCollapsed() ?? false);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage write errors.
      }
      return next;
    });
  };

  const menuItems = [
    {
      key: 'dashboard',
      icon: <DashboardOutlined style={{ fontSize: '16px' }} />,
      label: 'Tổng quan Vận hành',
    },
    {
      key: 'orders',
      icon: <InboxOutlined style={{ fontSize: '16px' }} />,
      label: 'Đơn vận chuyển',
    },
    {
      key: 'dispatch-manual',
      icon: <CompassOutlined style={{ fontSize: '16px' }} />,
      label: 'Điều Phối Thủ Công',
    },
    {
      key: 'dispatch-auto',
      icon: <ThunderboltOutlined style={{ fontSize: '16px' }} />,
      label: 'Điều Phối Tự Động',
    },
    {
      key: 'fleet',
      icon: <CarOutlined style={{ fontSize: '16px' }} />,
      label: 'Đội Xe & Tài Xế',
    },
    { key: 'delivery-appointments', icon: <InboxOutlined />, label: 'Lịch hẹn giao hàng' },
    { key: 'settings', icon: <SettingOutlined aria-hidden="true" />, label: 'Cấu hình chung' },
    { key: 'accounts', icon: <UserOutlined aria-hidden="true" />, label: 'Quản lý tài khoản' },
  ];

  const toggleButton = (
    <Tooltip title={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'} placement="right">
      <Button
        type="text"
        size="small"
        className="tms-sidebar-toggle"
        icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        onClick={toggleCollapsed}
        aria-label={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'}
        aria-expanded={!collapsed}
      />
    </Tooltip>
  );

  const footerContent = (
    <div className={`tms-sidebar-footer ${collapsed ? 'tms-sidebar-footer-collapsed' : ''}`}>
      <span
        style={{
          display: 'inline-block',
          flexShrink: 0,
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#22c55e',
          boxShadow: '0 0 6px rgba(34, 197, 94, 0.6)',
        }}
      />
      {!collapsed && <span style={{ fontWeight: 500, color: '#475569' }}>Hệ thống trực tuyến</span>}
    </div>
  );

  return (
    <Sider
      className={`tms-sidebar ${collapsed ? 'tms-sidebar-collapsed' : ''}`}
      collapsible
      collapsed={collapsed}
      trigger={null}
      width={220}
      breakpoint="lg"
      collapsedWidth={68}
      onBreakpoint={(broken) => {
        if (readStoredCollapsed() === null) {
          setCollapsed(broken);
        }
      }}
      style={{
        background: '#ffffff',
        borderRight: '1px solid #e2e8f0',
        minHeight: 'calc(100vh - 64px)',
        flexShrink: 0,
      }}
    >
      <div className="tms-sidebar-inner">
        <div className={`tms-sidebar-header ${collapsed ? 'tms-sidebar-header-collapsed' : ''}`}>
          {!collapsed && <span className="tms-sidebar-label">Danh mục chức năng</span>}
          {toggleButton}
        </div>
        <Menu
          className="tms-sidebar-menu"
          mode="inline"
          inlineCollapsed={collapsed}
          selectedKeys={[currentTab]}
          onClick={({ key }) => onSelectTab(key)}
          items={menuItems.filter((item) => canOpenTab(user, item.key, can))}
        />
        {collapsed ? (
          <Tooltip title="Hệ thống trực tuyến" placement="right">
            {footerContent}
          </Tooltip>
        ) : (
          footerContent
        )}
      </div>
    </Sider>
  );
};

export default Sidebar;

