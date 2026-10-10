import { canOpenTab, defaultTab } from './utils/navigationAccess';
import React, { useEffect, useState, lazy, Suspense } from 'react';
import AccountsPage from './pages/AccountsPage';
import { canManageAccounts } from './types/accounts';
import { Layout, ConfigProvider, theme, App as AntdApp, Spin, Alert, Button, Result } from 'antd';
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


const MainLayout: React.FC = () => {
  const { user, token, loading, error, retry, logout, scopeVersion, can } = useAuth();
  const [currentTab, setTab] = useState(() => window.location.pathname.slice(1) || 'dashboard');
  const setCurrentTab = (tab: string) => { setTab(tab); window.history.pushState(null, '', tab === 'dashboard' ? '/' : '/' + tab); };
  useEffect(() => {
    const pop = () => setTab(window.location.pathname.slice(1) || 'dashboard');
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  useEffect(() => {
    if (user && window.location.pathname === '/' && defaultTab(user) !== 'dashboard') setCurrentTab(defaultTab(user));
  }, [user?.id]);

  if (loading) {
    return <Spin fullscreen aria-label="Đang kiểm tra phiên" />;
  }

  if (!user && token && error) return <Result status="warning" title="Chưa xác minh được phiên" subTitle={error} extra={<><Button onClick={() => void retry()}>Thử lại</Button><Button onClick={() => void logout()}>Xóa phiên</Button></>} />;
  if (!user) {
    return <LoginPage />;
  }

  const renderContent = () => {
    if (currentTab === 'accounts') return canManageAccounts(user) ? <AccountsPage /> : <Result status="403" title="Không có quyền truy cập" subTitle="Bạn không được phép quản lý tài khoản." />;
    if (!canOpenTab(user, currentTab, can)) return <Result status="403" title="Không có quyền truy cập" />;
    switch (currentTab) {
      case 'dashboard':
        return <DashboardPage onNavigate={setCurrentTab} />;
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
        return <DashboardPage onNavigate={setCurrentTab} />;
    }
  };

  return (
    <Layout className="tms-app">
      <a className="skip-link" href="#main-content">Bỏ qua menu, tới nội dung chính</a>
      <Navbar />
      <Layout>
        <Sidebar currentTab={currentTab} onSelectTab={setCurrentTab} />
        <Content key={`${user.id}:${scopeVersion}`} style={{ minHeight: 'calc(100vh - 64px)', background: '#f8fafc' }}>
          {error && <Alert type="warning" showIcon message={error} />}
          <Suspense fallback={<Spin />}>{renderContent()}</Suspense>
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
