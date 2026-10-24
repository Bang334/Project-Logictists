import React from 'react';
import { Layout, Button, Space, Typography, Tag, Select, Grid } from 'antd';
import { CarOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Header } = Layout;
const { Text } = Typography;

const Navbar: React.FC = () => {
  const screens = Grid.useBreakpoint();
  const { user, logout, branchId, setBranchId } = useAuth();

  return (
    <Header
      className="tms-navbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        flexWrap: 'wrap',
        gap: 12,
        background: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        boxShadow: '0 2px 8px rgba(15, 23, 42, 0.05)',
        minHeight: 64,
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
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
          }}
        >
          <CarOutlined aria-label="TMS Logistics" style={{ color: '#0284c7', fontSize: '20px' }} />
        </div>
        <div>
          <span style={{ color: '#0f172a', fontWeight: 800, fontSize: '18px', letterSpacing: '-0.02em' }}>
            TMS LOGISTICS
          </span>
        </div>
      </div>

      <Space size="middle" wrap>
        <Select
          aria-label="Chi nhánh làm việc"
          style={{ minWidth: 220 }}
          value={branchId || 'ALL'}
          onChange={(value) => setBranchId(value === 'ALL' ? undefined : value)}
          options={[
            { value: 'ALL', label: user?.companyScope ? 'Toàn công ty' : 'Các chi nhánh được cấp' },
            ...(user?.branches || []).map((b) => ({ value: b.id, label: b.name })),
          ]}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Tag color="geekblue" icon={<UserOutlined />}>
            {[...new Set(user?.grants.map((g) => g.role))].join(', ') || user?.role}
          </Tag>
          <Text style={{ color: '#1e293b', fontWeight: 600 }}>
            {user?.fullName || user?.username}
          </Text>
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

