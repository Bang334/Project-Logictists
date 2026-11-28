import React from 'react';
import { Layout, Button, Typography, Tag, Grid, Divider } from 'antd';
import { CarOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Header } = Layout;
const { Text } = Typography;

const Navbar: React.FC = () => {
  const screens = Grid.useBreakpoint();
  const { user, logout } = useAuth();
  const roleLabel = [...new Set(user?.grants.map((g) => g.role))].join(', ') || user?.role;

  return (
    <Header
      className="tms-navbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px 0 15px',
        gap: 16,
        background: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        boxShadow: '0 1px 6px rgba(15, 23, 42, 0.05)',
        height: 64,
        lineHeight: 'normal',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      <div className="tms-brand" style={{ gap: 12 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: 'linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(2, 132, 199, 0.15)',
            flexShrink: 0,
          }}
        >
          <CarOutlined aria-label="TMS Logistics" style={{ color: '#0284c7', fontSize: 20 }} />
        </div>
        <div className="tms-brand-copy">
          <strong>TMS LOGISTICS</strong>
          <small>Hệ thống điều phối vận tải</small>
        </div>
      </div>

      <div className="tms-navbar-actions">
        <div className="tms-user-pill">
          <UserOutlined style={{ color: '#0f5593', fontSize: 14 }} />
          <Text style={{ color: '#1e293b', fontWeight: 600, fontSize: 13 }}>
            {user?.fullName || user?.username}
          </Text>
          {roleLabel && (
            <Tag color="geekblue" style={{ margin: 0, fontSize: 11, fontWeight: 700 }}>
              {roleLabel}
            </Tag>
          )}
        </div>

        <Divider type="vertical" style={{ height: 22, margin: 0, borderColor: '#cbd5e1' }} />

        <Button
          className="tms-logout-button"
          type="text"
          icon={<LogoutOutlined />}
          onClick={logout}
          aria-label="Đăng xuất"
        >
          {screens.lg ? 'Đăng xuất' : null}
        </Button>
      </div>
    </Header>
  );
};

export default Navbar;

