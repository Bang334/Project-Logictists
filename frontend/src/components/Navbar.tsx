import React from 'react';
import { Layout, Button, Space, Typography, Tag } from 'antd';
import { CarOutlined, EnvironmentOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Header } = Layout;
const { Text } = Typography;

const Navbar: React.FC = () => {
  const { user, logout } = useAuth();

  return (
    <Header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        background: '#001529',
        borderBottom: '1px solid #1e293b',
        height: '64px',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <CarOutlined aria-label="TMS Logistics" style={{ color: '#60a5fa', fontSize: '24px' }} />
        <div>
          <span style={{ color: '#ffffff', fontWeight: 700, fontSize: '18px', letterSpacing: '-0.02em' }}>
            TMS LOGISTICS
          </span>
          <span style={{ color: '#94a3b8', fontSize: '12px', marginLeft: '8px' }}>
            Phase 1: Core Dispatch
          </span>
        </div>
      </div>

      <Space size="middle">
        {user?.branch && (
          <Tag icon={<EnvironmentOutlined />} color="blue" style={{ padding: '4px 10px', fontSize: '13px' }}>
            {user.branch.name}
          </Tag>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Tag color="geekblue" icon={<UserOutlined />}>
            {user?.role}
          </Tag>
          <Text style={{ color: '#ffffff', fontWeight: 500 }}>
            {user?.fullName || user?.username}
          </Text>
        </div>

        <Button
          type="text"
          icon={<LogoutOutlined />}
          onClick={logout}
          style={{ color: '#cbd5e1' }}
        >
          Đăng xuất
        </Button>
      </Space>
    </Header>
  );
};

export default Navbar;
