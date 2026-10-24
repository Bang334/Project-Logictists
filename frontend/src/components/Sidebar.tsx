import { canOpenTab } from '../utils/navigationAccess';

import React from 'react';
import { Layout, Menu } from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  CarOutlined,
  CompassOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  InboxOutlined,
  ShopOutlined,
  ShoppingOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Sider } = Layout;

interface SidebarProps {
  currentTab: string;
  onSelectTab: (key: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab }) => {
  const { can, user } = useAuth();
  const menuItems = [
    {
      key: 'dashboard',
      icon: <DashboardOutlined style={{ fontSize: '16px' }} />,
      label: 'Tổng quan Vận hành',
    },
    {
      key: 'orders',
      icon: <ShoppingOutlined style={{ fontSize: '16px' }} />,
      label: 'Quản lý Đơn hàng',
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
    { key: 'catalog', icon: <AppstoreOutlined />, label: 'Danh mục hàng' },
    { key: 'inventory', icon: <DatabaseOutlined />, label: 'Tồn kho' },
    { key: 'sales-orders', icon: <ShoppingOutlined />, label: 'Đơn bán lẻ' },
    { key: 'order-processing', icon: <InboxOutlined />, label: 'Xử lý đơn bán lẻ' },
    { key: 'pickup-ops', icon: <ShopOutlined />, label: 'Điểm nhận hàng' },
    { key: 'retail-analytics', icon: <BarChartOutlined />, label: 'Báo cáo bán lẻ' },
    { key: 'customer-shop', icon: <ShopOutlined />, label: 'Đặt hàng' },
    { key: 'accounts', icon: <UserOutlined aria-hidden="true" />, label: 'Quản lý tài khoản' },
  ];



  return (
    <Sider
      className="tms-sidebar"
      width={240}
      breakpoint="lg"
      collapsedWidth={0}
      style={{
        background: '#ffffff',
        borderRight: '1px solid #e2e8f0',
        minHeight: 'calc(100vh - 64px)',
      }}
    >
      <div className="tms-sidebar-inner">
        <div className="tms-sidebar-label">Danh mục chức năng</div>
        <Menu
          className="tms-sidebar-menu"
          mode="inline"
          selectedKeys={[currentTab]}
          onClick={({ key }) => onSelectTab(key)}
          items={menuItems.filter((item) => canOpenTab(user, item.key, can))}
        />
        <div className="tms-sidebar-footer">
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#22c55e',
              boxShadow: '0 0 6px rgba(34, 197, 94, 0.6)',
            }}
          />
          <span style={{ fontWeight: 500, color: '#475569' }}>Hệ thống trực tuyến</span>
        </div>
      </div>
    </Sider>
  );
};

export default Sidebar;

