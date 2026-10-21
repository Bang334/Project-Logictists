import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, DatePicker, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import dayjs, { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { fleetApi, fleetFieldErrors } from '../api/fleet';
import { apiErrorMessage } from '../api/client';
import type { FleetKind, FleetProfile, FleetSchedule } from '../types/fleet';
dayjs.extend(utc); dayjs.extend(timezone);
export const VN_ZONE = 'Asia/Ho_Chi_Minh';
export const inVietnam = (s: string) => dayjs(s).tz(VN_ZONE).format('DD/MM/YYYY HH:mm');
export const pickerUtc = (d: Dayjs) => dayjs.tz(d.format('YYYY-MM-DD HH:mm:ss'), VN_ZONE).toISOString();
export const scheduleLabels: Record<string, string> = { SHIFT: 'Ca làm', LEAVE: 'Nghỉ phép', OTHER: 'Nghỉ khác', MAINTENANCE: 'Bảo dưỡng', BREAKDOWN: 'Hỏng xe thực tế', LEGACY: 'Lịch cũ chưa phân loại' };

export function FleetSchedulePanel({ kind, resource, canManage, onChanged }: { kind: FleetKind; resource: FleetProfile; canManage: boolean; onChanged: () => void }) {
  const { message } = App.useApp(); const [form] = Form.useForm();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('day'), dayjs().add(7, 'day').endOf('day')]);
  const [rows, setRows] = useState<FleetSchedule[]>([]), [total, setTotal] = useState(0), [page, setPage] = useState(1);
  const [affectedTrips, setAffectedTrips] = useState<Array<{ id: string; tripNumber: string; status: string }>>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [formError, setFormError] = useState(''), [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<FleetSchedule | null | undefined>(), [cancelling, setCancelling] = useState<FleetSchedule | null>(null), [cancelReason, setCancelReason] = useState('');
  const key = useRef(crypto.randomUUID()), payload = useRef(''), pending = useRef(false), generation = useRef(0);
  const fetchRows = useCallback(async () => { const seq = ++generation.current; setLoading(true); setError('');
    try { const params = { startsAt: pickerUtc(range[0]), endsAt: pickerUtc(range[1]), page, pageSize: 10 }; const [r, a] = await Promise.all([fleetApi.schedules(kind, resource.id, params), fleetApi.resourceWindow(kind, resource.id, params)]); if (seq === generation.current) { setRows(r.items); setAffectedTrips(a.affectedTrips); setTotal(Math.max(r.shiftTotal ?? r.total, r.leaveTotal ?? 0)); } }
    catch (e) { if (seq === generation.current) { setRows([]); setError(apiErrorMessage(e)); } } finally { if (seq === generation.current) setLoading(false); }
  }, [kind, resource.id, range, page]);
  useEffect(() => { const counter = generation; void fetchRows(); return () => { counter.current++; }; }, [fetchRows]);
  const startEdit = (row: FleetSchedule | null) => { setEditing(row); setFormError(''); key.current = crypto.randomUUID(); payload.current = ''; form.resetFields(); form.setFieldsValue(row ? { ...row, range: [dayjs(row.startsAt).tz(VN_ZONE), row.endsAt ? dayjs(row.endsAt).tz(VN_ZONE) : null] } : { kind: kind === 'drivers' ? 'SHIFT' : 'MAINTENANCE' }); };
  const save = async (values: { kind: string; range: [Dayjs, Dayjs]; reason: string }) => {
    if (pending.current) return; pending.current = true; setSaving(true); setFormError('');
    try { const data = { kind: values.kind, startsAt: pickerUtc(values.range[0]), endsAt: pickerUtc(values.range[1]), reason: values.reason, ...(editing ? { version: editing.version } : {}) };
      if (payload.current && payload.current !== JSON.stringify(data)) key.current = crypto.randomUUID(); payload.current = JSON.stringify(data);
      await fleetApi.saveSchedule(kind, resource.id, data, key.current, editing?.id, editing?.kind); setEditing(undefined); message.success('Đã lưu lịch'); setRange(values.range); setPage(1); onChanged();
    } catch (e) { form.setFields(fleetFieldErrors(e)); setFormError(apiErrorMessage(e)); } finally { setSaving(false); pending.current = false; }
  };
  const cancel = async () => { if (!cancelling || pending.current || !cancelReason.trim()) return; pending.current = true; setSaving(true); setFormError('');
    try { await fleetApi.cancelSchedule(kind, resource.id, cancelling.id, cancelling.kind, { version: cancelling.version, reason: cancelReason }, key.current); setCancelling(null); message.success('Đã hủy hiệu lực lịch'); await fetchRows(); onChanged(); }
    catch (e) { setFormError(apiErrorMessage(e)); } finally { pending.current = false; setSaving(false); }
  };
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Alert type="info" message="Giờ Việt Nam (UTC+7). Khoảng [bắt đầu, kết thúc), cho phép tiếp giáp. Ca không chứng minh đã nghỉ đủ hoặc có thể đến nhận việc." />
    {kind === 'drivers' && !resource.employeeId && <Alert type="warning" message="Tài xế chưa liên kết Employee. Liên kết hồ sơ trước khi khai báo lịch." />}
    <Space wrap><DatePicker.RangePicker showTime format="DD/MM/YYYY HH:mm" value={range} onChange={r => { if (r?.[0] && r[1]) { setRange([r[0], r[1]]); setPage(1); } }} /><Button onClick={() => void fetchRows()}>Tải lại lịch</Button>
      {canManage && <Button type="primary" disabled={kind === 'drivers' && !resource.employeeId} onClick={() => startEdit(null)}>Thêm lịch</Button>}</Space>
    {error && <Alert type="error" message={error} />}
    {affectedTrips.length > 0 && <Alert type="warning" message="Các chuyến trong khoảng đang xem — điều phối viên cần đối chiếu xung đột" description={affectedTrips.map(t => <div key={t.id}>{t.tripNumber} ({t.status})</div>)} />}
    <Table<FleetSchedule> rowKey="id" size="small" loading={loading} dataSource={rows} scroll={{ x: 650 }} pagination={{ current: page, total, pageSize: 10, onChange: setPage }} columns={[
      { title: 'Loại', render: (_, r) => scheduleLabels[r.kind] ?? r.kind },
      { title: 'Bắt đầu → kết thúc', render: (_, r) => `${inVietnam(r.startsAt)} → ${r.endsAt ? inVietnam(r.endsAt) : 'Chưa xác định'}` },
      { title: 'Lý do', dataIndex: 'reason' }, { title: 'Hiệu lực', render: (_, r) => <Tag>{r.status}</Tag> },
      { title: 'Thao tác', render: (_, r) => canManage && r.status === 'ACTIVE' && r.kind !== 'LEGACY' ? <Space><Button onClick={() => startEdit(r)}>Sửa</Button><Button danger onClick={() => { setCancelling(r); setCancelReason(''); setFormError(''); key.current = crypto.randomUUID(); }}>Hủy</Button></Space> : null },
    ]} />
    {kind === 'drivers' && <small>Ca và nghỉ được phân trang riêng, tối đa 10 dòng mỗi nguồn trên một trang.</small>}
    <Modal open={editing !== undefined} title={editing ? 'Sửa lịch' : 'Thêm lịch'} onCancel={() => setEditing(undefined)} onOk={() => form.submit()} okText="Lưu lịch" cancelText="Đóng" confirmLoading={saving}>
      {formError && <Alert type="error" message={formError} />}
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="kind" label="Loại lịch" rules={[{ required: true }]}><Select disabled={!!editing} options={(kind === 'vehicles' ? ['MAINTENANCE', 'BREAKDOWN'] : ['SHIFT', 'LEAVE', 'OTHER']).map(k => ({ value: k, label: scheduleLabels[k] }))} /></Form.Item>
        <Form.Item name="range" label="Bắt đầu / kết thúc — giờ Việt Nam" rules={[{ required: true }]}><DatePicker.RangePicker showTime format="DD/MM/YYYY HH:mm" /></Form.Item>
        <Form.Item name="reason" label="Lý do" rules={[{ required: true, whitespace: true }, { max: 1000 }]}><Input.TextArea /></Form.Item>
      </Form>
    </Modal>
    <Modal open={!!cancelling} title="Hủy hiệu lực lịch" onCancel={() => setCancelling(null)} onOk={() => void cancel()} okText="Xác nhận hủy" confirmLoading={saving} okButtonProps={{ disabled: !cancelReason.trim() }}>
      {formError && <Alert type="error" message={formError} />}<Input.TextArea aria-label="Lý do hủy lịch" value={cancelReason} onChange={e => { setCancelReason(e.target.value); key.current = crypto.randomUUID(); }} />
    </Modal>
  </Space>;
}
