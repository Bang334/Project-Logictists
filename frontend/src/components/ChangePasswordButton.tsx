import { useRef, useState } from 'react';
import { Alert, Button, Form, Input, Modal } from 'antd';
import axios from 'axios';
import { apiErrorMessage, authApi } from '../api/client';

interface Values { currentPassword: string; newPassword: string; confirmPassword: string }

export default function ChangePasswordButton() {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const [form] = Form.useForm<Values>();
  const submit = async (values: Values) => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError(undefined);
    try {
      await authApi.changePassword(values.currentPassword, values.newPassword);
      form.resetFields(); setOpen(false);
      window.dispatchEvent(new Event('tms:unauthorized'));
    } catch (e) {
      const message = apiErrorMessage(e);
      setError(message);
      if (axios.isAxiosError(e)) {
        const field: unknown = e.response?.data?.field;
        if (field === 'currentPassword' || field === 'newPassword') {
          form.setFields([{ name: field, errors: [message] }]);
        }
      }
    }
    finally { busy.current = false; setSaving(false); }
  };
  return <>
    <Button onClick={() => { setError(undefined); setOpen(true); }}>Đổi mật khẩu</Button>
    <Modal title="Đổi mật khẩu của tôi" open={open} footer={null} closable={!saving} maskClosable={!saving}
      onCancel={() => { if (!busy.current) { form.resetFields(); setOpen(false); } }}>
      <Alert type="info" showIcon message="Sau khi đổi, mọi phiên sẽ bị thu hồi. Bạn cần đăng nhập lại trên web và ứng dụng." style={{ marginBottom: 16 }} />
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical" disabled={saving} onFinish={submit}>
        <Form.Item name="currentPassword" label="Mật khẩu hiện tại" rules={[{ required: true, message: 'Nhập mật khẩu hiện tại' }]}><Input.Password autoComplete="current-password" /></Form.Item>
        <Form.Item name="newPassword" label="Mật khẩu mới" rules={[{ validator: (_, value: unknown) => typeof value === 'string' && new TextEncoder().encode(value).length >= 12 && new TextEncoder().encode(value).length <= 72 ? Promise.resolve() : Promise.reject(new Error('Mật khẩu phải có từ 12 đến 72 byte UTF-8')) }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item name="confirmPassword" label="Xác nhận mật khẩu mới" dependencies={['newPassword']} rules={[{ required: true, message: 'Xác nhận mật khẩu mới' }, { validator: (_, value: unknown) => value === form.getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('Mật khẩu xác nhận không khớp')) }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Button htmlType="submit" type="primary" loading={saving}>Đổi mật khẩu và đăng xuất</Button>
      </Form>
    </Modal>
  </>;
}
