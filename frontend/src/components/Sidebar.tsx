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
} from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Sider } = Layout;

interface SidebarProps {
  currentTab: string;
  onSelectTab: (key: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab }) => {
  const { user } = useAuth();
  const menuItems = [
    { key: 'customer-shop', icon: <ShoppingOutlined />, label: 'Mua hàng & đơn của tôi' },
    { key: 'dashboard', icon: <DashboardOutlined />, label: 'Tổng quan vận hành' },
    { key: 'catalog', icon: <AppstoreOutlined />, label: 'Danh mục & giá' },
    { key: 'inventory', icon: <DatabaseOutlined />, label: 'Tồn kho' },
    { key: 'sales-orders', icon: <ShoppingOutlined />, label: 'Đơn bán hàng' },
    { key: 'order-processing', icon: <InboxOutlined />, label: 'Chuẩn bị & đóng kiện' },
    { key: 'pickup-ops', icon: <ShopOutlined />, label: 'Điểm nhận & giao khách' },
    { key: 'retail-analytics', icon: <BarChartOutlined />, label: 'Doanh thu & đối soát' },
    { key: 'orders', icon: <CarOutlined />, label: 'Đơn vận tải' },
    { key: 'dispatch-manual', icon: <CompassOutlined />, label: 'Điều phối thủ công' },
    { key: 'dispatch-auto', icon: <ThunderboltOutlined />, label: 'Điều phối tự động' },
    { key: 'fleet', icon: <CarOutlined />, label: 'Đội xe & tài xế' },
  ];

  const allowedByRole: Record<string, string[]> = {
    CUSTOMER: ['customer-shop'],
    DRIVER: ['dashboard'],
    DISPATCHER: ['dashboard', 'orders', 'fleet', 'dispatch-manual', 'dispatch-auto'],
    STAFF: ['dashboard', 'catalog', 'inventory', 'sales-orders', 'order-processing', 'pickup-ops'],
    ADMIN: menuItems.map((item) => item.key).filter((key) => key !== 'customer-shop'),
  };
  const visibleItems = menuItems.filter((item) =>
    user ? (allowedByRole[user.role] || []).includes(item.key) : false,
  );

  return (
    <Sider width={264} breakpoint="lg" collapsedWidth={0} className="tms-sidebar">
      <div className="tms-sidebar-inner">
        <div className="tms-sidebar-label">Không gian làm việc</div>
        <Menu
          mode="inline"
          selectedKeys={[currentTab]}
          onClick={({ key }) => onSelectTab(key)}
          className="tms-sidebar-menu"
          items={visibleItems}
        />
        <div className="tms-sidebar-footer">
          <span className="tms-status-dot" aria-hidden="true" />
          Hệ thống đang hoạt động
        </div>
      </div>
    </Sider>
  );
};

export default Sidebar;
