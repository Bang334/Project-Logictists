import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Typography } from 'antd';
import axios from 'axios';
import { apiErrorMessage, ordersApi } from '../api/client';
import type { Order } from '../types';

export function CancelOrderModal({ order, onClose, onSaved, onReload }: {
  order: Order; onClose: () => void; onSaved: (order: Order) => void; onReload: (order: Order) => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ reason: string }>();
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false);
  const busy = useRef(false), live = useRef(true);
  const command = useRef<{ reason: string; key: string }>();
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const submit = async ({ reason }: { reason: string }) => {
    if (busy.current || conflict) return;
    busy.current = true; setSaving(true); setError('');
    if (!command.current || command.current.reason !== reason) command.current = { reason, key: crypto.randomUUID() };
    try {
      const saved = await ordersApi.cancel(order.id, order.version, reason, command.current.key);
      if (live.current) { message.success('Đã hủy đơn trên server'); onSaved(saved); }
    } catch (e) {
      if (live.current) { setError(apiErrorMessage(e)); setConflict(axios.isAxiosError(e) && e.response?.status === 409); }
    } finally { busy.current = false; if (live.current) setSaving(false); }
  };
  const reload = async () => {
    if (busy.current) return;
    busy.current = true; setSaving(true);
    try { const latest = await ordersApi.getOne(order.id); if (live.current) onReload(latest); }
    catch (e) { if (live.current) setError(apiErrorMessage(e)); }
    finally { busy.current = false; if (live.current) setSaving(false); }
  };
  return <Modal open title="Hủy đơn vận tải" onCancel={() => { if (!busy.current) onClose(); }} maskClosable={false} closable={!saving} keyboard={!saving} footer={null} width={560} style={{ maxWidth: 'calc(100vw - 24px)' }}>
    <Typography.Paragraph style={{ overflowWrap: 'anywhere' }}>Đơn: <strong>{order.orderNumber}</strong></Typography.Paragraph>
    <Alert type="warning" showIcon message="Đơn và các kiện sẽ chuyển sang CANCELLED, rời danh sách chờ điều phối. Lịch sử được giữ nguyên. Không thể phục hồi." description="Server sẽ kiểm tra phân công và lịch sử vận chuyển trước khi hủy." />
    {error && <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} />}
    {conflict && <Alert style={{ marginTop: 12 }} type="info" message="Tải lại chi tiết để đối chiếu. Không tự gửi lại lệnh với version mới." action={<Button loading={saving} onClick={() => void reload()}>Tải lại để đối chiếu</Button>} />}
    <Form form={form} layout="vertical" onFinish={values => void submit(values)} style={{ marginTop: 16 }}>
      <Form.Item name="reason" label="Lý do hủy" rules={[{ required: true, whitespace: true, message: 'Nhập lý do hủy' }, { max: 1000, message: 'Tối đa 1000 ký tự' }]}>
        <Input.TextArea autoFocus maxLength={1000} rows={4} disabled={saving || conflict} />
      </Form.Item>
      <Button danger type="primary" htmlType="submit" loading={saving} disabled={conflict}>Xác nhận hủy đơn</Button>
      <Button disabled={saving} onClick={onClose} style={{ marginLeft: 8 }}>Đóng</Button>
    </Form>
  </Modal>;
}
