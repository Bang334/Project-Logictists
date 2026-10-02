import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Layout, ConfigProvider, theme, App as AntdApp, Spin, Typography } from 'antd';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const OrdersPage = lazy(() => import('./pages/OrdersPage'));
const FleetPage = lazy(() => import('./pages/FleetPage'));
const DispatchPage = lazy(() => import('./pages/DispatchPage'));
const AutomaticDispatchPage = lazy(() => import('./pages/AutomaticDispatchPage'));
const CatalogPage = lazy(() => import('./pages/CatalogPage'));
const InventoryPage = lazy(() => import('./pages/InventoryPage'));
const RetailOrdersPage = lazy(() => import('./pages/RetailOrdersPage'));
const OrderProcessingPage = lazy(() => import('./pages/OrderProcessingPage'));
const PickupPointOpsPage = lazy(() => import('./pages/PickupPointOpsPage'));
const RetailAnalyticsPage = lazy(() => import('./pages/RetailAnalyticsPage'));
const CustomerPortalPage = lazy(() => import('./pages/CustomerPortalPage'));

const { Content } = Layout;
const { Text } = Typography;

const MainLayout: React.FC = () => {
  const { user, loading } = useAuth();
  const [currentTab, setCurrentTab] = useState(() => window.location.hash.slice(1) || 'dashboard');

  const allowedTabs = useCallback(() => {
    if (!user) return [];
    if (user.role === 'CUSTOMER') return ['customer-shop'];
    if (user.role === 'DRIVER') return ['dashboard'];
    if (user.role === 'DISPATCHER') {
      return ['dashboard', 'orders', 'fleet', 'dispatch-manual', 'dispatch-auto'];
    }
    if (user.role === 'STAFF') {
      return ['dashboard', 'catalog', 'inventory', 'sales-orders', 'order-processing', 'pickup-ops'];
    }
    return ['dashboard', 'catalog', 'inventory', 'sales-orders', 'order-processing', 'pickup-ops', 'retail-analytics', 'orders', 'fleet', 'dispatch-manual', 'dispatch-auto'];
  }, [user]);

  const navigate = useCallback((tab: string) => {
    window.location.hash = tab;
  }, []);

  useEffect(() => {
    if (!user) return;
    const syncFromHash = () => {
      const requested = window.location.hash.slice(1);
      const fallback = user.role === 'CUSTOMER' ? 'customer-shop' : 'dashboard';
      const next = allowedTabs().includes(requested) ? requested : fallback;
      setCurrentTab(next);
      if (requested !== next) window.history.replaceState(null, '', `#${next}`);
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, [allowedTabs, user]);

  useEffect(() => {
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [currentTab]);

  if (loading) {
    return (
      <div role="status" aria-live="polite" style={{ display: 'grid', minHeight: '100vh', placeItems: 'center' }}>
        <div style={{ display: 'grid', justifyItems: 'center', gap: 12 }}>
          <Spin size="large" />
          <Text>Đang xác thực phiên đăng nhập...</Text>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const renderContent = () => {
    switch (currentTab) {
      case 'dashboard':
        return <DashboardPage onNavigate={navigate} />;
      case 'customer-shop':
        return <CustomerPortalPage />;
      case 'catalog':
        return <CatalogPage />;
      case 'inventory':
        return <InventoryPage />;
      case 'sales-orders':
        return <RetailOrdersPage />;
      case 'order-processing':
        return <OrderProcessingPage />;
      case 'pickup-ops':
        return <PickupPointOpsPage />;
      case 'retail-analytics':
        return <RetailAnalyticsPage />;
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
        return <DashboardPage onNavigate={navigate} />;
    }
  };

  return (
    <Layout className="tms-app">
      <a className="skip-link" href="#main-content">Bỏ qua menu, tới nội dung chính</a>
      <Navbar />
      <Layout>
        <Sidebar currentTab={currentTab} onSelectTab={navigate} />
        <Content id="main-content" tabIndex={-1} className="tms-content">
          <Suspense
            fallback={
              <div style={{ display: 'grid', minHeight: '50vh', placeItems: 'center' }}>
                <div style={{ display: 'grid', justifyItems: 'center', gap: 12 }}>
                  <Spin size="large" />
                  <Text>Đang tải màn hình...</Text>
                </div>
              </div>
            }
          >
            {renderContent()}
          </Suspense>
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
          colorPrimary: '#0f5593',
          colorInfo: '#0284c7',
          colorLink: '#0f5593',
          colorSuccess: '#16a34a',
          colorSuccessBg: '#f0fdf4',
          colorSuccessBgHover: '#dcfce7',
          colorSuccessBorder: '#bbf7d0',
          colorSuccessBorderHover: '#86efac',
          colorSuccessText: '#15803d',
          colorSuccessTextHover: '#166534',
          colorSuccessTextActive: '#14532d',
          colorInfoBg: '#f0f9ff',
          colorInfoBgHover: '#e0f2fe',
          colorInfoBorder: '#bae6fd',
          colorInfoBorderHover: '#7dd3fc',
          colorInfoText: '#0284c7',
          colorInfoTextHover: '#0369a1',
          colorInfoTextActive: '#075985',
          colorWarning: '#d97706',
          colorWarningBg: '#fffbeb',
          colorWarningBorder: '#fde68a',
          colorWarningText: '#b45309',
          colorError: '#dc2626',
          colorErrorBg: '#fef2f2',
          colorErrorBorder: '#fecaca',
          colorErrorText: '#b91c1c',
          colorText: '#18243a',
          colorTextSecondary: '#526176',
          colorBorder: '#d6e1ec',
          colorBorderSecondary: '#e1e9f2',
          colorBgLayout: '#f2f7fc',
          borderRadius: 8,
          borderRadiusLG: 10,
          controlHeight: 42,
          fontFamily: "'Be Vietnam Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          fontSize: 14,
          boxShadow: '0 8px 24px rgba(21, 55, 88, 0.08)',
          boxShadowSecondary: '0 2px 8px rgba(21, 55, 88, 0.06)',
        },
        components: {
          Button: {
            controlHeight: 42,
            fontWeight: 700,
            primaryShadow: '0 5px 12px rgba(15, 85, 147, 0.18)',
          },
          Card: {
            headerBg: '#ffffff',
          },
          Menu: {
            itemBorderRadius: 10,
            itemSelectedBg: '#edf5fc',
            itemSelectedColor: '#0b477d',
            itemHoverBg: '#f3f7fb',
          },
          Table: {
            headerBg: '#f3f7fb',
            headerColor: '#26364d',
            rowHoverBg: '#f0f6fc',
            borderColor: '#e1e9f2',
          },
          Tabs: {
            itemSelectedColor: '#0b477d',
            inkBarColor: '#d51f2b',
          },
          Tag: {
            defaultBg: '#f8fafc',
            defaultColor: '#334155',
          },
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
