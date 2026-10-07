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
    { key: 'customer-shop', icon: <ShopOutlined />, label: 'Đặt hàng' },
    { key: 'catalog', icon: <AppstoreOutlined />, label: 'Danh mục hàng' },
    { key: 'inventory', icon: <DatabaseOutlined />, label: 'Tồn kho' },
    { key: 'sales-orders', icon: <ShoppingOutlined />, label: 'Đơn bán lẻ' },
    { key: 'order-processing', icon: <InboxOutlined />, label: 'Xử lý đơn bán lẻ' },
    { key: 'pickup-ops', icon: <ShopOutlined />, label: 'Điểm nhận hàng' },
    { key: 'retail-analytics', icon: <BarChartOutlined />, label: 'Báo cáo bán lẻ' },
    { key: 'accounts', icon: <UserOutlined aria-hidden="true" />, label: 'Quản lý tài khoản' },
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
  ];


  return (
    <Sider
      width={240}
      breakpoint="lg"
      collapsedWidth={0}
      style={{
        background: '#ffffff',
        borderRight: '1px solid #e2e8f0',
        minHeight: 'calc(100vh - 64px)',
      }}
    >
      <Menu
        mode="inline"
        selectedKeys={[currentTab]}
        onClick={({ key }) => onSelectTab(key)}
        style={{ borderRight: 0, paddingTop: '12px' }}
        items={menuItems.filter(item => canOpenTab(user, item.key, can))}
      />
    </Sider>
  );
};

export default Sidebar;
