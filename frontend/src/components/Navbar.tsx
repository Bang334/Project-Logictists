import React from 'react';
import { Layout, Button, Space, Typography, Tag, Select } from 'antd';
import { CarOutlined, EnvironmentOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Header } = Layout;
const { Text } = Typography;

const Navbar: React.FC = () => {
  const { user, logout, branchId, setBranchId } = useAuth();

  return (
    <Header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 16px',
        flexWrap: 'wrap',
        gap: 12,
        background: '#001529',
        borderBottom: '1px solid #1e293b',
        height: 'auto',
        minHeight: 64,
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

      <Space size="middle" wrap>
        <Select aria-label="Chi nhánh làm việc" style={{ minWidth: 210 }} value={branchId || 'ALL'} onChange={value => setBranchId(value === 'ALL' ? undefined : value)} options={[{ value: 'ALL', label: user?.companyScope ? 'Toàn công ty' : 'Các chi nhánh được cấp' }, ...(user?.branches || []).map(b => ({ value: b.id, label: b.name }))]} />

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Tag color="geekblue" icon={<UserOutlined />}>
            {[...new Set(user?.grants.map(g => g.role))].join(', ')}
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
