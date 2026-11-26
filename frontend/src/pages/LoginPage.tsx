import React, { useRef, useState } from 'react';
import { Alert, Button, Card, Form, Input, Space, Tag, Typography } from 'antd';
import {
  CarOutlined,
  CheckCircleFilled,
  CompassOutlined,
  DeploymentUnitOutlined,
  EnvironmentOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../api/client';

interface DemoAccount {
  roleName: string;
  hubCode: string;
  tagColor: string;
  username: string;
  password: string;
  description: string;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    roleName: 'Quản trị viên',
    hubCode: 'HQ-ALL',
    tagColor: 'blue',
    username: 'admin',
    password: 'admin123',
    description: 'Toàn quyền hệ thống & cấu hình mạng lưới',
  },
  {
    roleName: 'Điều phối HN',
    hubCode: 'HUB-HAN',
    tagColor: 'cyan',
    username: 'dispatcher_hn',
    password: 'dispatcher123',
    description: 'Trung tâm Khai thác Miền Bắc (Hà Nội)',
  },
  {
    roleName: 'Điều phối HCM',
    hubCode: 'HUB-SGN',
    tagColor: 'geekblue',
    username: 'dispatcher_sgn',
    password: 'dispatcher123',
    description: 'Trung tâm Khai thác Miền Nam (TP.HCM)',
  },
];

const FEATURE_HIGHLIGHTS = [
  {
    icon: <CompassOutlined />,
    title: 'Định tuyến Động OR-Tools',
    subtitle: 'Tối ưu lộ trình đa điểm, khung giờ nhận – giao & ca lái',
  },
  {
    icon: <DeploymentUnitOutlined />,
    title: 'Xếp dỡ 3D & Tải trọng',
    subtitle: 'Kiểm soát kích thước kiện, thứ tự LIFO & tải từng chặng',
  },
  {
    icon: <EnvironmentOutlined />,
    title: 'Giám sát Hành trình Live',
    subtitle: 'Bản đồ Mapbox thời gian thực, cảnh báo ETA & chứng từ POD',
  },
];

export default function LoginPage() {
  const { login, error: sessionError } = useAuth();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedDemoUser, setSelectedDemoUser] = useState<string>();
  const submitting = useRef(false);

  const submit = async (values: { username: string; password: string }) => {
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError(undefined);
    try {
      await login(values.username.trim(), values.password);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  };

  const handleQuickFill = (username: string, password: string) => {
    form.setFieldsValue({ username, password });
    setSelectedDemoUser(username);
    setError(undefined);
  };

  const handleQuickLogin = async (username: string, password: string) => {
    form.setFieldsValue({ username, password });
    setSelectedDemoUser(username);
    await submit({ username, password });
  };

  return (
    <main className="login-shell">
      <section className="login-intro" aria-label="Giới thiệu hệ thống điều hành vận tải TMS">
        <div className="login-brand-bar">
          <div className="login-brand">
            <span className="login-brand-mark" aria-hidden="true">
              <CarOutlined />
            </span>
            <span className="login-brand-text">
              <strong>TMS LOGISTICS</strong>
              <small>Fleet &amp; Cargo Control Tower</small>
            </span>
          </div>
          <span className="login-live-pill">
            <span className="login-live-dot" aria-hidden="true" />
            Mạng lưới Bắc – Nam trực tuyến
          </span>
        </div>

        <div className="login-intro-content">
          <span className="login-eyebrow">
            <CompassOutlined /> HỆ THỐNG QUẢN LÝ &amp; ĐIỀU PHỐI VẬN TẢI
          </span>
          <Typography.Title level={1} className="login-intro-title">
            Điều phối đội xe, tối ưu xếp dỡ &amp; giám sát lộ trình thời gian thực
          </Typography.Title>
          <Typography.Text className="login-intro-desc">
            Nền tảng điều hành hợp nhất cho trung tâm khai thác vận tải: kết nối phân bổ đơn hàng,
            kiểm tra hình học thùng xe 3D không chồng kiện và theo dõi tiến độ giao nhận xuyên suốt.
          </Typography.Text>

          <div className="login-route-card" aria-label="Trục vận hành liên vùng">
            <div className="login-route-header">
              <span className="login-route-title">
                <CarOutlined /> Trục điều vận liên chi nhánh
              </span>
              <div className="login-route-badges">
                <span className="login-route-badge">OR-Tools + Hybrid ALNS</span>
                <span className="login-route-badge">3D LIFO Packing</span>
                <span className="login-route-badge login-route-badge--accent">Mapbox GPS</span>
              </div>
            </div>

            <div className="login-route-corridor">
              <div className="login-hub-node">
                <span className="login-hub-code">HUB-HAN</span>
                <span className="login-hub-name">Hà Nội</span>
                <span className="login-hub-meta">Khai thác Miền Bắc</span>
              </div>

              <div className="login-route-leg" aria-hidden="true">
                <span className="login-route-leg-label">Luồng tuyến trục</span>
                <span className="login-route-line" />
              </div>

              <div className="login-hub-node login-hub-node--mid">
                <span className="login-hub-code">CONTROL</span>
                <span className="login-hub-name">Điều phối &amp; Xếp tải</span>
                <span className="login-hub-meta">Kiểm soát tải từng chặng</span>
              </div>

              <div className="login-route-leg" aria-hidden="true">
                <span className="login-route-leg-label">Theo dõi ETA</span>
                <span className="login-route-line" />
              </div>

              <div className="login-hub-node login-hub-node--end">
                <span className="login-hub-code">HUB-SGN</span>
                <span className="login-hub-name">TP. Hồ Chí Minh</span>
                <span className="login-hub-meta">Khai thác Miền Nam</span>
              </div>
            </div>
          </div>

          <div className="login-feature-list">
            {FEATURE_HIGHLIGHTS.map((item) => (
              <div key={item.title} className="login-feature-card">
                <span className="login-feature-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="login-feature-copy">
                  <strong>{item.title}</strong>
                  <small>{item.subtitle}</small>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="login-system-status">
          <span className="login-system-status-left">
            <CheckCircleFilled /> Cổng điều hành sẵn sàng tiếp nhận ca trực
          </span>
          <span className="login-system-status-right">
            Phân quyền theo Chi nhánh &amp; Vai trò (RBAC)
          </span>
        </div>
      </section>

      <section className="login-form-panel" aria-labelledby="login-title">
        <Card className="login-card">
          <div className="login-mobile-brand">
            <span className="login-mobile-mark" aria-hidden="true">
              <CarOutlined />
            </span>
            <div className="login-mobile-brand-copy">
              <strong>TMS LOGISTICS</strong>
              <small>Hệ thống Điều phối &amp; Quản lý Vận tải</small>
            </div>
          </div>

          <div className="login-card-heading">
            <div className="login-card-top-row">
              <span className="login-eyebrow">CỔNG ĐIỀU VẬN • DISPATCH PORTAL</span>
              <span className="login-security-badge">
                <SafetyCertificateOutlined /> Bảo mật phiên
              </span>
            </div>
            <Typography.Title id="login-title" level={3} className="login-card-title">
              Đăng nhập TMS
            </Typography.Title>
            <Typography.Paragraph className="login-card-subtitle">
              Sử dụng tài khoản được quản trị viên cấp để vào ca điều phối.
            </Typography.Paragraph>
          </div>

          {(error || sessionError) && (
            <Alert
              role="alert"
              type="error"
              showIcon
              message={error || sessionError}
              className="login-error-alert"
            />
          )}

          <Form form={form} layout="vertical" onFinish={submit} disabled={loading}>
            <Form.Item
              name="username"
              label="Tên đăng nhập"
              rules={[
                { required: true, whitespace: true, message: 'Vui lòng nhập tên đăng nhập' },
                { max: 100 },
              ]}
            >
              <Input
                prefix={<UserOutlined />}
                autoComplete="username"
                maxLength={100}
                placeholder="Nhập mã nhân sự hoặc tên đăng nhập"
              />
            </Form.Item>
            <Form.Item
              name="password"
              label="Mật khẩu"
              rules={[
                { required: true, message: 'Vui lòng nhập mật khẩu' },
                { max: 72 },
              ]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                autoComplete="current-password"
                maxLength={72}
                placeholder="Nhập mật khẩu ca trực"
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={loading}
              className="login-submit"
            >
              Đăng nhập
            </Button>
          </Form>

          <div className="login-demo-section">
            <div className="login-demo-header">
              <Typography.Text strong className="login-demo-title">
                <ThunderboltOutlined className="login-demo-title-icon" />
                Tài khoản demo theo ca trực (đăng nhập nhanh):
              </Typography.Text>
              <Typography.Text type="secondary" className="login-demo-hint">
                Nhấn để chọn
              </Typography.Text>
            </div>

            <div className="login-demo-list">
              {DEMO_ACCOUNTS.map((acc) => {
                const isSelected = selectedDemoUser === acc.username;
                return (
                  <div
                    key={acc.username}
                    onClick={() => handleQuickFill(acc.username, acc.password)}
                    className={`login-demo-item${isSelected ? ' login-demo-item--active' : ''}`}
                    title={`Nhấn để điền tài khoản ${acc.roleName}`}
                  >
                    <div className="login-demo-info">
                      <div className="login-demo-role-row">
                        <Tag color={acc.tagColor} className="login-demo-role-tag">
                          {acc.roleName}
                        </Tag>
                        <span className="login-demo-hub-badge">{acc.hubCode}</span>
                        <Typography.Text code className="login-demo-username">
                          {acc.username}
                        </Typography.Text>
                      </div>
                      <Typography.Text type="secondary" className="login-demo-meta">
                        MK: <code>{acc.password}</code> • {acc.description}
                      </Typography.Text>
                    </div>

                    <Space size={6} onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="small"
                        onClick={() => handleQuickFill(acc.username, acc.password)}
                        title="Điền vào form"
                        className="login-demo-btn"
                      >
                        Điền
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        icon={<ThunderboltOutlined />}
                        aria-label="Đăng nhập nhanh"
                        loading={loading}
                        onClick={() => handleQuickLogin(acc.username, acc.password)}
                        title="Đăng nhập ngay lập tức"
                        className="login-demo-btn"
                      >
                        Đăng nhập nhanh
                      </Button>
                    </Space>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      </section>
    </main>
  );
}
