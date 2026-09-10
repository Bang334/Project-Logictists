import React from 'react';
import { Layout, Menu } from 'antd';
import {
  DashboardOutlined,
  ShoppingOutlined,
  CarOutlined,
  CompassOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

const { Sider } = Layout;

interface SidebarProps {
  currentTab: string;
  onSelectTab: (key: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab }) => {
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
        items={menuItems}
      />
    </Sider>
  );
};

export default Sidebar;
