import React, { useState } from 'react';
import { Alert, App as AntdApp, Button, Card, Form, Input, Typography } from 'antd';
import {
  BarChartOutlined,
  CheckCircleFilled,
  LockOutlined,
  SafetyCertificateOutlined,
  TruckOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Title, Text } = Typography;

type LoginValues = {
  username: string;
  pass: string;
};

const DEMO_CREDENTIALS: LoginValues = {
  username: 'admin',
  pass: 'admin123',
};

const LoginPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const { login } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: LoginValues) => {
    setLoading(true);
    try {
      await login(values.username, values.pass);
      message.success('Đăng nhập hệ thống TMS thành công!');
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      message.error(error.response?.data?.message || 'Sai tên đăng nhập hoặc mật khẩu');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-intro" aria-labelledby="login-intro-title">
        <div className="login-brand">
          <span className="login-brand-mark"><TruckOutlined /></span>
          <span><strong>TMS Logistics</strong><small>Transport Management System</small></span>
        </div>

        <div className="login-intro-content">
          <span className="login-eyebrow">Trung tâm điều hành hợp nhất</span>
          <Title id="login-intro-title" level={1}>
            Vận hành vận tải rõ ràng, từ kế hoạch đến giao hàng.
          </Title>
          <Text>
            Theo dõi đơn, nguồn lực và tiến độ trong một không gian làm việc tập trung cho đội vận hành.
          </Text>

          <div className="login-feature-list">
            <div><TruckOutlined /><span><strong>Điều phối chuyến</strong><small>Phân công và theo dõi tiến độ</small></span></div>
            <div><BarChartOutlined /><span><strong>Dữ liệu vận hành</strong><small>Tồn kho, đơn hàng và đối soát</small></span></div>
            <div><SafetyCertificateOutlined /><span><strong>Kiểm soát truy cập</strong><small>Không gian theo vai trò người dùng</small></span></div>
          </div>
        </div>

        <div className="login-system-status">
          <CheckCircleFilled /> Sẵn sàng tiếp nhận phiên làm việc
        </div>
      </section>

      <section className="login-form-panel" aria-labelledby="login-title">
        <Card className="login-card">
          <div className="login-card-heading">
            <span className="login-mobile-mark"><TruckOutlined /></span>
            <span className="login-eyebrow">Cổng vận hành</span>
            <Title id="login-title" level={2}>Chào mừng trở lại</Title>
            <Text type="secondary">Đăng nhập bằng tài khoản đã được cấp cho bạn.</Text>
          </div>

          {import.meta.env.DEV && (
            <Alert
              type="info"
              showIcon
              message="Tài khoản dùng thử"
              description={(
                <span className="login-demo-credentials">
                  <span>Tên đăng nhập: <strong>{DEMO_CREDENTIALS.username}</strong></span>
                  <span>Mật khẩu: <strong>{DEMO_CREDENTIALS.pass}</strong></span>
                </span>
              )}
              className="login-demo-alert"
            />
          )}

          <Form<LoginValues>
            layout="vertical"
            onFinish={handleSubmit}
            initialValues={import.meta.env.DEV ? DEMO_CREDENTIALS : undefined}
            autoComplete="off"
            requiredMark
          >
            <Form.Item
              label="Tên đăng nhập"
              name="username"
              rules={[{ required: true, message: 'Vui lòng nhập tên đăng nhập' }]}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder={import.meta.env.DEV ? 'admin' : 'Tên đăng nhập'}
                autoComplete={import.meta.env.DEV ? 'off' : 'username'}
                size="large"
              />
            </Form.Item>

            <Form.Item
              label="Mật khẩu"
              name="pass"
              rules={[{ required: true, message: 'Vui lòng nhập mật khẩu' }]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder={import.meta.env.DEV ? 'admin123' : 'Mật khẩu'}
                autoComplete={import.meta.env.DEV ? 'new-password' : 'current-password'}
                size="large"
              />
            </Form.Item>

            <Button type="primary" htmlType="submit" size="large" block loading={loading} className="login-submit">
              Đăng nhập
            </Button>
          </Form>
          <Text className="login-help">Liên hệ quản trị viên nếu bạn chưa có quyền truy cập.</Text>
        </Card>
      </section>
    </main>
  );
};

export default LoginPage;
