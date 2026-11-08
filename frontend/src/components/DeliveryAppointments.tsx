import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, DatePicker, Empty, Form, Input, InputNumber, List, Modal, Pagination, Space, Spin, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { apiClient, apiErrorMessage } from '../api/client';
import { getRealtimeSocket } from '../api/realtime';

export interface DeliveryAppointment {
  id: string; batchId: string; orderId: string; version: number; status: string;
  windowStart: string; windowEnd: string; expiresAt: string;
  requestedStart?: string | null; requestedEnd?: string | null; responseNote?: string | null;
  order: { orderNumber: string };
}
interface DeliveryBatch {
  id: string; status: string; expiresAt: string; windowMinutes: number;
  finalOptimizationJobId?: string | null; appointments: DeliveryAppointment[];
}
const labels: Record<string, string> = {
  PENDING: 'Chờ phản hồi', CONFIRMED: 'Đã xác nhận', DECLINED: 'Không nhận được',
  CHANGE_REQUESTED: 'Yêu cầu đổi khung', EXPIRED: 'Hết hạn phản hồi', SCHEDULED: 'Đã chốt tuyến',
  CANCELLED: 'Đã thu hồi', OFFERING: 'Đang hẹn khách', APPLIED: 'Đã chốt',
};
const dateTime = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' });
const appointmentStatus = (row: DeliveryAppointment) => row.status === 'PENDING' && Date.parse(row.expiresAt) <= Date.now() ? 'EXPIRED' : row.status;

export const CustomerDeliveryInbox: React.FC = () => {
  const [items, setItems] = useState<DeliveryAppointment[]>([]), [total, setTotal] = useState(0), [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState<string>();
  const [changing, setChanging] = useState<DeliveryAppointment | null>(null);
  const [form] = Form.useForm<{ requestedStart?: Dayjs; requestedEnd?: Dayjs; note?: string }>();
  const command = useRef<{ fingerprint: string; key: string }>();
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.get<{ items: DeliveryAppointment[]; total: number }>('/delivery-planning/mine', { params: { page } });
      setItems(response.data.items); setTotal(response.data.total); setError('');
    } catch (failure) { setError(apiErrorMessage(failure)); }
    finally { setLoading(false); }
  }, [page]);
  useEffect(() => {
    void refresh();
    const socket = getRealtimeSocket();
    const update = () => void refresh();
    socket?.on('delivery:appointment-updated', update); socket?.on('connect', update);
    const timer = window.setInterval(update, 30000);
    return () => { window.clearInterval(timer); socket?.off('delivery:appointment-updated', update); socket?.off('connect', update); };
  }, [refresh]);
  const respond = async (row: DeliveryAppointment, decision: string, change?: { requestedStart?: Dayjs; requestedEnd?: Dayjs; note?: string }) => {
    if (busy) return;
    const payload = { version: row.version, decision, requestedStart: change?.requestedStart?.toISOString(), requestedEnd: change?.requestedEnd?.toISOString(), note: change?.note };
    const fingerprint = JSON.stringify({ id: row.id, ...payload });
    if (command.current?.fingerprint !== fingerprint) command.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(row.id); setError('');
    try {
      await apiClient.post(`/delivery-planning/appointments/${row.id}/respond`, { ...payload, idempotencyKey: command.current.key });
      command.current = undefined; setChanging(null); form.resetFields(); await refresh();
    } catch (failure) { setError(apiErrorMessage(failure)); }
    finally { setBusy(undefined); }
  };
  return <Card title="Thông báo hẹn nhận hàng" style={{ marginBottom: 20 }} extra={<Button loading={loading} onClick={() => void refresh()}>Tải lại</Button>}>
    <Typography.Paragraph>Khung giờ dưới đây do doanh nghiệp đề xuất sau khi đã xét tuyến và giữ chỗ. Bạn có thể xác nhận hoặc yêu cầu khung khác; yêu cầu đổi chưa phải lịch được cam kết.</Typography.Paragraph>
    {error && <Alert type="error" showIcon message={error} />}
    <Spin spinning={loading}>
      {!items.length && !loading ? <Empty description="Chưa có đề xuất nhận hàng" /> : <List dataSource={items} renderItem={row => <List.Item key={row.id}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap><strong>{row.order.orderNumber}</strong><Tag>{labels[appointmentStatus(row)] ?? row.status}</Tag></Space>
          <Typography.Text>{dateTime(row.windowStart)} – {dateTime(row.windowEnd)} (UTC+7)</Typography.Text>
          <Typography.Text type="secondary">Phản hồi trước {dateTime(row.expiresAt)}</Typography.Text>
          {row.responseNote && <Typography.Text>{row.responseNote}</Typography.Text>}
          {appointmentStatus(row) === 'PENDING' && <Space wrap>
            <Button type="primary" loading={busy === row.id} disabled={!!busy} onClick={() => void respond(row, 'CONFIRMED')}>Tôi nhận được trong khung này</Button>
            <Button disabled={!!busy} onClick={() => { form.resetFields(); setChanging(row); }}>Yêu cầu đổi khung</Button>
            <Button disabled={!!busy} onClick={() => void respond(row, 'DECLINED')}>Không nhận được</Button>
          </Space>}
        </Space>
      </List.Item>} />}
    </Spin>
    {total > 20 && <Pagination current={page} total={total} pageSize={20} onChange={setPage} />}
    <Modal title="Yêu cầu đổi khung nhận hàng" open={!!changing} onCancel={() => { if (!busy) setChanging(null); }} onOk={() => form.submit()} confirmLoading={!!busy}>
      <Typography.Paragraph>Doanh nghiệp sẽ kiểm tra lại tuyến và năng lực trước khi gửi một đề xuất mới. Chỗ của khung cũ được giải phóng khi bạn gửi yêu cầu đổi.</Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={values => changing && void respond(changing, 'CHANGE_REQUESTED', values)}>
        <Form.Item name="requestedStart" label="Có thể nhận từ (tùy chọn)"><DatePicker showTime format="DD/MM/YYYY HH:mm" /></Form.Item>
        <Form.Item name="requestedEnd" label="Có thể nhận đến (tùy chọn)"><DatePicker showTime format="DD/MM/YYYY HH:mm" /></Form.Item>
        <Form.Item name="note" label="Ghi chú"><Input.TextArea maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  </Card>;
};

export const DispatcherDeliveryPlanning: React.FC<{ branchId: string; jobId?: string; candidateNumber: number; canPropose: boolean; onJob: (id: string) => Promise<void> }> = ({ branchId, jobId, candidateNumber, canPropose, onJob }) => {
  const [batches, setBatches] = useState<DeliveryBatch[]>([]);
  const [loading, setLoading] = useState(false), [loadError, setLoadError] = useState(''), [error, setError] = useState('');
  const [dialog, setDialog] = useState<'propose' | 'responses' | null>(null), [busy, setBusy] = useState(false);
  const [form] = Form.useForm<{ windowMinutes: number; expiresAt: Dayjs }>();
  const command = useRef<{ fingerprint: string; key: string }>();
  const optimizeKeys = useRef(new Map<string, string>());
  const refreshSequence = useRef(0);
  const refresh = useCallback(async (showLoading = false) => {
    const sequence = ++refreshSequence.current;
    if (showLoading) setLoading(true);
    try {
      const response = await apiClient.get<DeliveryBatch[]>('/delivery-planning/batches', { params: { branchId } });
      if (sequence !== refreshSequence.current) return;
      setBatches(response.data);
      setLoadError('');
    } catch (failure) { if (sequence === refreshSequence.current) setLoadError(apiErrorMessage(failure)); }
    finally { if (showLoading) setLoading(false); }
  }, [branchId]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 15000); return () => window.clearInterval(timer); }, [refresh]);
  const activeBatches = batches.filter(batch => batch.status === 'OFFERING');
  const activeAppointments = activeBatches.flatMap(batch => batch.appointments);
  const confirmedCount = activeAppointments.filter(row => row.status === 'CONFIRMED').length;
  const pendingCount = activeAppointments.filter(row => appointmentStatus(row) === 'PENDING').length;
  const changeCount = activeAppointments.filter(row => row.status === 'CHANGE_REQUESTED').length;
  const hasResponsesToTrack = confirmedCount + pendingCount + changeCount > 0;
  const showProposal = canPropose && !!jobId && !batches.some(batch => batch.finalOptimizationJobId === jobId);
  const openDialog = (next: 'propose' | 'responses') => { setError(''); setDialog(next); };
  const closeDialog = () => { if (!busy) setDialog(null); };
  const propose = async (values: { windowMinutes: number; expiresAt: Dayjs }) => {
    if (!showProposal || !jobId || busy) return;
    const payload = { jobId, candidateNumber, windowMinutes: values.windowMinutes, expiresAt: values.expiresAt.toISOString() };
    const fingerprint = JSON.stringify(payload);
    if (command.current?.fingerprint !== fingerprint) command.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const { data: batch } = await apiClient.post<DeliveryBatch>('/delivery-planning/batches', { ...payload, idempotencyKey: command.current.key });
      setBatches(previous => [batch, ...previous.filter(row => row.id !== batch.id)]);
      command.current = undefined;
      setDialog(null);
      form.resetFields();
      await refresh();
    }
    catch (failure) { setError(apiErrorMessage(failure)); }
    finally { setBusy(false); }
  };
  const optimize = async (batch: DeliveryBatch) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (batch.finalOptimizationJobId) {
        const previous = await apiClient.get<{ status: string }>(`/trips/automatic-optimization/jobs/${batch.finalOptimizationJobId}`);
        if (!['FAILED','CANCELLED','INFEASIBLE','TIMEOUT','PARTIAL'].includes(previous.data.status)) { await onJob(batch.finalOptimizationJobId); setDialog(null); return; }
        optimizeKeys.current.delete(batch.id);
      }
      const key = optimizeKeys.current.get(batch.id) ?? crypto.randomUUID(); optimizeKeys.current.set(batch.id, key);
      const response = await apiClient.post<{ id: string }>(`/delivery-planning/batches/${batch.id}/optimize`, { idempotencyKey: key });
      await onJob(response.data.id); setDialog(null); await refresh();
    } catch (failure) { setError(apiErrorMessage(failure)); }
    finally { setBusy(false); }
  };
  return <>
    {showProposal && <Button size="large" disabled={busy} onClick={() => openDialog('propose')}>Gửi khung giờ cho khách</Button>}
    {(hasResponsesToTrack || loadError) && <Space wrap>
      {hasResponsesToTrack && <Typography.Text type="secondary">
        {confirmedCount} đơn đã xác nhận · {pendingCount} đơn đang chờ{changeCount > 0 && ` · ${changeCount} yêu cầu đổi khung`}
      </Typography.Text>}
      <Button onClick={() => openDialog('responses')}>Xem phản hồi</Button>
    </Space>}
    <Modal title="Phản hồi hẹn giao" open={dialog === 'responses'} onCancel={closeDialog}
      footer={<Button onClick={() => void refresh(true)} loading={loading}>Tải phản hồi</Button>}>
      {loadError && <Alert type="error" showIcon message={loadError} />}
      {error && <Alert type="error" showIcon message={error} />}
      <List dataSource={batches} locale={{ emptyText: 'Chưa có đợt hẹn giao' }} renderItem={batch => {
        const pending = batch.appointments.filter(row => appointmentStatus(row) === 'PENDING').length;
        const confirmed = batch.appointments.filter(row => row.status === 'CONFIRMED').length;
        return <List.Item key={batch.id}><Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Tag>{labels[batch.status] ?? batch.status}</Tag>
            <Typography.Text>Hạn phản hồi {dateTime(batch.expiresAt)} · {confirmed} xác nhận · {pending} đang chờ</Typography.Text>
            {batch.status === 'OFFERING' && <Button disabled={pending > 0 || confirmed === 0 || busy} loading={busy} onClick={() => void optimize(batch)}>
              {batch.finalOptimizationJobId ? 'Xem lượt tối ưu chốt' : 'Tối ưu chốt các đơn đã xác nhận'}
            </Button>}
          </Space>
          {batch.appointments.map(row => <div key={row.id}>
            {row.order.orderNumber}: {dateTime(row.windowStart)} – {dateTime(row.windowEnd)} <Tag>{labels[appointmentStatus(row)] ?? row.status}</Tag>
            {row.requestedStart && row.requestedEnd && <span>Muốn đổi: {dateTime(row.requestedStart)} – {dateTime(row.requestedEnd)}</span>}
            {row.responseNote && <span> · {row.responseNote}</span>}
          </div>)}
        </Space></List.Item>;
      }} />
    </Modal>
    <Modal title="Gửi khung giờ cho khách" open={dialog === 'propose'} onCancel={closeDialog} onOk={() => form.submit()}
      okText="Gửi đề xuất" okButtonProps={{ disabled: !showProposal }} confirmLoading={busy}>
      {error && <Alert type="error" showIcon message={error} />}
      <Typography.Paragraph>Phương án #{candidateNumber} dùng để đề xuất khung giờ cho các đơn giao trọn trong ca ngày tiếp theo. Các đơn giao ngày sau tiếp tục chờ.</Typography.Paragraph>
      <Typography.Paragraph>Chọn độ rộng tối đa và hạn phản hồi. Hệ thống giữ xe và tài xế cho đợt hẹn. Khi đã nhận đủ phản hồi hoặc hết hạn, chỉ các đơn đã xác nhận được tối ưu chốt theo khung đã hẹn.</Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={values => void propose(values)}>
        <Form.Item name="windowMinutes" label="Độ rộng tối đa mỗi khung (phút)" rules={[{ required: true }]}><InputNumber min={1} max={1440} precision={0} /></Form.Item>
        <Form.Item name="expiresAt" label="Hạn khách phản hồi (trước khung giao sớm nhất)" rules={[{ required: true }]}><DatePicker showTime format="DD/MM/YYYY HH:mm" /></Form.Item>
      </Form>
    </Modal>
  </>;
};
