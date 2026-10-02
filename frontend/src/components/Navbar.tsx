import React from 'react';
import { Avatar, Button, Grid, Layout, Space, Tag, Typography } from 'antd';
import {
  CarOutlined,
  EnvironmentOutlined,
  LogoutOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Header } = Layout;
const { Text } = Typography;

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Quản trị viên',
  DISPATCHER: 'Điều phối viên',
  STAFF: 'Nhân viên',
  DRIVER: 'Tài xế',
  CUSTOMER: 'Khách hàng',
};

const Navbar: React.FC = () => {
  const { user, logout } = useAuth();
  const screens = Grid.useBreakpoint();
  const displayName = user?.fullName || user?.username || 'Người dùng';

  return (
    <Header className="tms-navbar">
      <div className="tms-brand" aria-label="TMS Logistics">
        <span className="tms-brand-mark"><CarOutlined /></span>
        <span className="tms-brand-copy">
          <strong>TMS Logistics</strong>
          {screens.md && <small>Trung tâm vận hành</small>}
        </span>
      </div>

      <Space size={screens.md ? 16 : 8} className="tms-navbar-actions">
        {screens.lg && user?.branch && (
          <Tag className="tms-branch-tag" icon={<EnvironmentOutlined />}>
            {user.branch.name}
          </Tag>
        )}

        <div className="tms-user-summary">
          <Avatar className="tms-user-avatar" icon={<UserOutlined />} />
          {screens.md && (
            <span className="tms-user-copy">
              <Text>{displayName}</Text>
              <small>{ROLE_LABELS[user?.role || ''] || user?.role}</small>
            </span>
          )}
        </div>

        <Button
          className="tms-logout-button"
          type="text"
          icon={<LogoutOutlined />}
          onClick={logout}
          aria-label="Đăng xuất"
        >
          {screens.lg ? 'Đăng xuất' : null}
        </Button>
      </Space>
    </Header>
  );
};

export default Navbar;
