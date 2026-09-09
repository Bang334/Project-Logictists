import React, { useState } from 'react';
import { Layout, ConfigProvider, theme } from 'antd';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';
import DashboardPage from './pages/DashboardPage';
import OrdersPage from './pages/OrdersPage';
import FleetPage from './pages/FleetPage';
import DispatchPage from './pages/DispatchPage';

const { Content } = Layout;

const MainLayout: React.FC = () => {
  const { user, loading } = useAuth();
  const [currentTab, setCurrentTab] = useState('dashboard');

  if (loading) {
    return null;
  }

  if (!user) {
    return <LoginPage />;
  }

  const renderContent = () => {
    switch (currentTab) {
      case 'dashboard':
        return <DashboardPage onNavigate={setCurrentTab} />;
      case 'orders':
        return <OrdersPage />;
      case 'fleet':
        return <FleetPage />;
      case 'dispatch':
        return <DispatchPage />;
      default:
        return <DashboardPage onNavigate={setCurrentTab} />;
    }
  };

  return (
    <Layout style={{ minHeight: '100vh', background: '#f8fafc' }}>
      <Navbar />
      <Layout>
        <Sidebar currentTab={currentTab} onSelectTab={setCurrentTab} />
        <Content style={{ minHeight: 'calc(100vh - 64px)', background: '#f8fafc' }}>
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
      <AuthProvider>
        <MainLayout />
      </AuthProvider>
    </ConfigProvider>
  );
};

export default App;
