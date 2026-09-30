import React, { useRef, useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../api/client';

export default function LoginPage() {
  const { login, error: sessionError } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const submit = async (values: { username: string; password: string }) => {
    if (submitting.current) return;
    submitting.current = true; setLoading(true); setError(undefined);
    try { await login(values.username.trim(), values.password); }
    catch (e) { setError(apiErrorMessage(e)); }
    finally { submitting.current = false; setLoading(false); }
  };
  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0f172a', padding: 20 }}>
    <Card style={{ width: '100%', maxWidth: 440 }}>
      <Typography.Title level={3}>Đăng nhập TMS</Typography.Title>
      <Typography.Paragraph type="secondary">Sử dụng tài khoản được quản trị viên cấp.</Typography.Paragraph>
      {(error || sessionError) && <Alert role="alert" type="error" showIcon message={error || sessionError} style={{ marginBottom: 20 }} />}
      <Form layout="vertical" onFinish={submit} disabled={loading}>
        <Form.Item name="username" label="Tên đăng nhập" rules={[{ required: true, whitespace: true, message: 'Vui lòng nhập tên đăng nhập' }, { max: 100 }]}>
          <Input prefix={<UserOutlined />} autoComplete="username" maxLength={100} />
        </Form.Item>
        <Form.Item name="password" label="Mật khẩu" rules={[{ required: true, message: 'Vui lòng nhập mật khẩu' }, { max: 72 }]}>
          <Input.Password prefix={<LockOutlined />} autoComplete="current-password" maxLength={72} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={loading}>Đăng nhập</Button>
      </Form>
    </Card>
  </main>;
}
