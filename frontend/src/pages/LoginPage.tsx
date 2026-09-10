import React, { useState } from 'react';
import { Card, Form, Input, Button, Typography, Alert, App as AntdApp } from 'antd';
import { UserOutlined, LockOutlined, TruckOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';

const { Title, Text } = Typography;

const LoginPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const { login } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: { username: string; pass: string }) => {
    setLoading(true);
    try {
      await login(values.username, values.pass);
      message.success('Đăng nhập hệ thống TMS thành công!');
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Sai tên đăng nhập hoặc mật khẩu');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
        padding: '20px',
      }}
    >
      <Card
        style={{
          width: 440,
          borderRadius: '12px',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)',
          border: '1px solid #334155',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div
            style={{
              display: 'inline-flex',
              padding: '12px',
              borderRadius: '50%',
              background: '#e0f2fe',
              color: '#0284c7',
              marginBottom: '12px',
            }}
          >
            <TruckOutlined style={{ fontSize: '32px' }} />
          </div>
          <Title level={3} style={{ margin: 0, color: '#0f172a' }}>
            Hệ Thống Quản Trị TMS
          </Title>
          <Text type="secondary">Đăng nhập cổng điều phối vận tải trực tuyến</Text>
        </div>

        <Alert
          type="info"
          showIcon
          message="Tài khoản dùng thử có sẵn trong database:"
          description={
            <div style={{ fontSize: '12px' }}>
              <div>• Quản trị viên: <code>admin</code> / <code>admin123</code></div>
              <div>• Điều phối viên: <code>dispatcher_hn</code> / <code>dispatcher123</code></div>
            </div>
          }
          style={{ marginBottom: '20px' }}
        />

        <Form layout="vertical" onFinish={handleSubmit} initialValues={{ username: 'admin', pass: 'admin123' }}>
          <Form.Item
            label="Tên đăng nhập"
            name="username"
            rules={[{ required: true, message: 'Vui lòng nhập username' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="Ví dụ: admin" size="large" />
          </Form.Item>

          <Form.Item
            label="Mật khẩu"
            name="pass"
            rules={[{ required: true, message: 'Vui lòng nhập mật khẩu' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="Mật khẩu" size="large" />
          </Form.Item>

          <Button type="primary" htmlType="submit" size="large" block loading={loading} style={{ marginTop: '8px' }}>
            Đăng Nhập Ngay
          </Button>
        </Form>
      </Card>
    </div>
  );
};

export default LoginPage;
