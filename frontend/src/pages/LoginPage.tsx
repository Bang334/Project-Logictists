import React, { useRef, useState } from 'react';
import { Alert, Button, Card, Form, Input, Space, Tag, Typography } from 'antd';
import { LockOutlined, ThunderboltOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../api/client';

interface DemoAccount {
  roleName: string;
  tagColor: string;
  username: string;
  password: string;
  description: string;
}
const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    roleName: 'Quản trị viên',
    tagColor: 'blue',
    username: 'admin',
    password: 'admin123',
    description: 'Toàn quyền hệ thống & cấu hình',
  },
  {
    roleName: 'Điều phối HN',
    tagColor: 'cyan',
    username: 'dispatcher_hn',
    password: 'dispatcher123',
    description: 'Chi nhánh Miền Bắc (Hà Nội)',
  },
  {
    roleName: 'Điều phối HCM',
    tagColor: 'geekblue',
    username: 'dispatcher_sgn',
    password: 'dispatcher123',
    description: 'Chi nhánh Miền Nam (TP.HCM)',
  },
];

export default function LoginPage() {
  const { login, error: sessionError } = useAuth();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
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
    setError(undefined);
  };

  const handleQuickLogin = async (username: string, password: string) => {
    form.setFieldsValue({ username, password });
    await submit({ username, password });
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0f172a', padding: 20 }}>
      <Card style={{ width: '100%', maxWidth: 460, borderRadius: 12, boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)' }}>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>Đăng nhập TMS</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>
          Sử dụng tài khoản được quản trị viên cấp.
        </Typography.Paragraph>
        {(error || sessionError) && (
          <Alert role="alert" type="error" showIcon message={error || sessionError} style={{ marginBottom: 20 }} />
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
            <Input prefix={<UserOutlined />} autoComplete="username" maxLength={100} placeholder="Nhập tên đăng nhập" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Mật khẩu"
            rules={[
              { required: true, message: 'Vui lòng nhập mật khẩu' },
              { max: 72 },
            ]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" maxLength={72} placeholder="Nhập mật khẩu" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading} style={{ height: 40, fontWeight: 600 }}>
            Đăng nhập
          </Button>
        </Form>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px dashed #cbd5e1' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <Typography.Text strong style={{ fontSize: 13, color: '#334155', display: 'flex', alignItems: 'center', gap: 6 }}>
              <ThunderboltOutlined style={{ color: '#0284c7' }} />
              Tài khoản demo (đăng nhập nhanh):
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              Nhấn để chọn
            </Typography.Text>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {DEMO_ACCOUNTS.map((acc) => (
              <div
                key={acc.username}
                onClick={() => handleQuickFill(acc.username, acc.password)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#93c5fd';
                  e.currentTarget.style.background = '#f0f9ff';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#e2e8f0';
                  e.currentTarget.style.background = '#f8fafc';
                }}
                title={`Nhấn để điền tài khoản ${acc.roleName}`}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Tag color={acc.tagColor} style={{ margin: 0, fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>
                      {acc.roleName}
                    </Tag>
                    <Typography.Text code style={{ fontSize: 12, margin: 0 }}>
                      {acc.username}
                    </Typography.Text>
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    MK: <code>{acc.password}</code> • {acc.description}
                  </Typography.Text>
                </div>

                <Space size={6} onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="small"
                    onClick={() => handleQuickFill(acc.username, acc.password)}
                    title="Điền vào form"
                    style={{ fontSize: 12 }}
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
                    style={{ fontSize: 12 }}
                  >
                    Đăng nhập nhanh
                  </Button>
                </Space>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </main>
  );
}
