import React, { useEffect, useState } from 'react';
import AccountsPage from './pages/AccountsPage';
import { canManageAccounts } from './types/accounts';
import { Layout, ConfigProvider, theme, App as AntdApp, Spin, Alert, Button, Result } from 'antd';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';
import DashboardPage from './pages/DashboardPage';
import OrdersPage from './pages/OrdersPage';
import FleetPage from './pages/FleetPage';
import DispatchPage from './pages/DispatchPage';
import AutomaticDispatchPage from './pages/AutomaticDispatchPage';

const { Content } = Layout;

const MainLayout: React.FC = () => {
  const { user, token, loading, error, retry, logout, scopeVersion, can } = useAuth();
  const [currentTab, setTab] = useState(() => window.location.pathname === '/accounts' ? 'accounts' : 'dashboard');
  const setCurrentTab = (tab: string) => { setTab(tab); window.history.pushState(null, '', tab === 'accounts' ? '/accounts' : '/'); };
  useEffect(() => {
    const pop = () => setTab(window.location.pathname === '/accounts' ? 'accounts' : 'dashboard');
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  if (loading) {
    return <Spin fullscreen tip="Đang kiểm tra phiên..." />;
  }

  if (!user && token && error) return <Result status="warning" title="Chưa xác minh được phiên" subTitle={error} extra={<><Button onClick={() => void retry()}>Thử lại</Button><Button onClick={() => void logout()}>Xóa phiên</Button></>} />;
  if (!user) {
    return <LoginPage />;
  }

  const renderContent = () => {
    if (currentTab === 'accounts') return canManageAccounts(user) ? <AccountsPage /> : <Result status="403" title="Không có quyền truy cập" subTitle="Bạn không được phép quản lý tài khoản." />;
    const required: Record<string, string> = { dashboard: 'orders.read', orders: 'orders.read', fleet: 'vehicles.read', dispatch: 'trips.plan', 'dispatch-manual': 'trips.plan', 'dispatch-auto': 'trips.plan' };
    if (!can(required[currentTab] || 'orders.read')) return <Result status="403" title="Không có quyền truy cập" subTitle="Phạm vi hoặc quyền đã bị thu hồi. Liên hệ quản trị viên." />;
    switch (currentTab) {
      case 'dashboard':
        return <DashboardPage onNavigate={setCurrentTab} />;
      case 'orders':
        return <OrdersPage />;
      case 'fleet':
        return <FleetPage />;
      case 'dispatch':
      case 'dispatch-manual':
        return <DispatchPage />;
      case 'dispatch-auto':
      case 'tracking-demo':
        return <AutomaticDispatchPage />;
      default:
        return <DashboardPage onNavigate={setCurrentTab} />;
    }
  };

  return (
    <Layout style={{ minHeight: '100vh', background: '#f8fafc' }}>
      <Navbar />
      <Layout>
        <Sidebar currentTab={currentTab} onSelectTab={setCurrentTab} />
        <Content key={`${user.id}:${scopeVersion}`} style={{ minHeight: 'calc(100vh - 64px)', background: '#f8fafc' }}>
          {error && <Alert type="warning" showIcon message={error} />}
          {renderContent()}
        </Content>
      </Layout>
    </Layout>
  );
};

const App: React.FC = () => {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1d4ed8',
          borderRadius: 6,
          fontFamily: 'Inter, sans-serif',
          colorBgLayout: '#f8fafc',
        },
      }}
    >
      <AntdApp>
        <AuthProvider>
          <MainLayout />
        </AuthProvider>
      </AntdApp>
    </ConfigProvider>
  );
};

export default App;
