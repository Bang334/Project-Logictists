import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Empty, Form, Input, Select, Space, Spin, Table, Typography } from 'antd';
import { apiClient, apiErrorMessage } from '../api/client';
import { AuditEntry, AuditPage, parseAudit, parseAuditPage } from '../types/audit';

const entities = { Order: 'Đơn vận tải', Customer: 'Khách hàng', Vehicle: 'Xe', Driver: 'Tài xế', VehicleUnavailability: 'Lịch xe', DriverShift: 'Ca tài xế', EmployeeLeave: 'Lịch nghỉ', User: 'Tài khoản', Branch: 'Chi nhánh' };
const actions = ['CREATE','UPDATE','CANCEL','LINK_EMPLOYEE','TRIP_CONFLICT_RECORDED','CREATED','UPDATED','PACKAGES_RECONCILED','CONFIRMED','CANCELLED','ACCOUNT_CREATED','ACCOUNT_UPDATED','ACCOUNT_LOCKED','ACCOUNT_UNLOCKED','PASSWORD_CHANGED','DRIVER_SCOPE_TRANSFERRED','BRANCH_CREATED','BRANCH_UPDATED','BRANCH_ACTIVATED','BRANCH_DEACTIVATED'];
const actionLabels: Record<string, string> = {
  CREATE: 'Tạo mới', UPDATE: 'Cập nhật', CANCEL: 'Hủy lịch', LINK_EMPLOYEE: 'Liên kết nhân viên', TRIP_CONFLICT_RECORDED: 'Ghi nhận xung đột chuyến',
  CREATED: 'Tạo đơn', UPDATED: 'Sửa đơn', PACKAGES_RECONCILED: 'Đối soát kiện', CONFIRMED: 'Xác nhận đơn', CANCELLED: 'Hủy đơn',
  ACCOUNT_CREATED: 'Tạo tài khoản', ACCOUNT_UPDATED: 'Sửa tài khoản/phạm vi', ACCOUNT_LOCKED: 'Khóa tài khoản', ACCOUNT_UNLOCKED: 'Mở khóa tài khoản', PASSWORD_CHANGED: 'Đổi mật khẩu', DRIVER_SCOPE_TRANSFERRED: 'Chuyển phạm vi tài xế',
  BRANCH_CREATED: 'Tạo chi nhánh', BRANCH_UPDATED: 'Sửa chi nhánh', BRANCH_ACTIVATED: 'Kích hoạt chi nhánh', BRANCH_DEACTIVATED: 'Ngừng chi nhánh',
};
const time = (v: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(v));
const changeValue = (v: string | null) => v === null ? 'Không ghi nhận' : /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)) ? time(v) : ({ DRAFT: 'Nháp', CONFIRMED: 'Đã xác nhận', CANCELLED: 'Đã hủy' } as Record<string,string>)[v] ?? v;
const localTime = (v: string) => Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v) + 7 * 3600000).toISOString().slice(0, 16) : '';
function initialQuery() {
  const p = new URLSearchParams(window.location.search);
  const today = Date.parse(new Date(Date.now() + 7 * 3600000).toISOString().slice(0,10) + 'T00:00:00+07:00');
  if (!p.has('from')) p.set('from', new Date(today - 6 * 86400000).toISOString());
  if (!p.has('to')) p.set('to', new Date(today + 86400000).toISOString());
  if (!p.has('page')) p.set('page', '1');
  if (!p.has('pageSize')) p.set('pageSize', '20');
  return p.toString();
}
const scopeLabel = (r: AuditEntry) => r.scope.branchIds.length ? r.scope.branchIds.join(', ') : 'Chưa xác định từ dữ liệu lịch sử';
type Filters = { from: string; to: string; actorUserId?: string; entityType?: string; action?: string; entityId?: string; branchId?: string };
export default function AuditLogsPage() {
  const [query, setQuery] = useState(initialQuery), [revision, setRevision] = useState(0);
  const [page, setPage] = useState<AuditPage>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [detail, setDetail] = useState<AuditEntry>(), [detailError, setDetailError] = useState(''), [detailLoading, setDetailLoading] = useState(false);
  const [form] = Form.useForm<Filters>();
  const generation = useRef(0);
  const params = new URLSearchParams(query), detailId = params.get('log'), source = params.get('source');
  const navigate = (p: URLSearchParams) => { const q = p.toString(); setPage(undefined); setDetail(undefined); if (q === query) { setRevision(v => v + 1); return; } window.history.pushState(null, '', '/audit-logs?' + q); setQuery(q); };
  useEffect(() => { window.history.replaceState(null, '', '/audit-logs?' + query); }, [query]);
  useEffect(() => {
    const pop = () => setQuery(initialQuery()); window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const p = new URLSearchParams(query);
    form.setFieldsValue({ from: localTime(p.get('from') ?? ''), to: localTime(p.get('to') ?? ''), actorUserId: p.get('actorUserId') ?? '', entityType: p.get('entityType') ?? undefined, action: p.get('action') ?? undefined, entityId: p.get('entityId') ?? '', branchId: p.get('branchId') ?? '' });
    p.delete('log'); p.delete('source');
    let live = true; const epoch = generation.current; setPage(undefined); setError(''); setLoading(true);
    void apiClient.get<unknown>('/audit-logs', { params: Object.fromEntries(p) }).then(r => { if (live && epoch === generation.current) setPage(parseAuditPage(r.data)); })
      .catch(e => { if (live) setError(apiErrorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [query, revision, form]);
  useEffect(() => {
    let live = true; const epoch = generation.current; setDetail(undefined); setDetailError('');
    if (!detailId || !source) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void apiClient.get<unknown>('/audit-logs/' + encodeURIComponent(source) + '/' + encodeURIComponent(detailId)).then(r => { if (live && epoch === generation.current) setDetail(parseAudit(r.data)); })
      .catch(e => { if (live) setDetailError(apiErrorMessage(e)); }).finally(() => { if (live) setDetailLoading(false); });
    return () => { live = false; };
  }, [detailId, source, revision]);
  useEffect(() => {
    const clear = () => { generation.current++; setPage(undefined); setDetail(undefined); };
    window.addEventListener('tms:forbidden', clear);
    return () => window.removeEventListener('tms:forbidden', clear);
  }, []);
  const apply = (values: Filters) => {
    const p = new URLSearchParams({ from: new Date(values.from + '+07:00').toISOString(), to: new Date(values.to + '+07:00').toISOString(), page: '1', pageSize: params.get('pageSize') ?? '20' });
    for (const key of ['actorUserId','entityType','action','entityId','branchId'] as const) if (values[key]?.trim()) p.set(key, values[key].trim());
    navigate(p);
  };
  return <main id="main-content" className="tms-page">
    <Typography.Title level={3}>Nhật ký thao tác quản trị</Typography.Title>
    <Alert type="info" showIcon message="ADMIN toàn công ty · Giờ Việt Nam (UTC+7) · Khoảng [từ, đến), tối đa 93 ngày" description="Bộ lọc chi nhánh chỉ tìm phạm vi đã ghi nhận. Nhật ký thiếu scope vẫn xem được khi bỏ bộ lọc; chi nhánh làm việc ở thanh trên không thu hẹp nhật ký toàn công ty." />
    <Form form={form} layout="vertical" onFinish={apply} style={{ marginTop: 16 }}>
      <Space wrap align="start">
        <Form.Item name="from" label="Từ ngày giờ" rules={[{ required: true }]}><Input type="datetime-local" aria-label="Từ ngày giờ" /></Form.Item>
        <Form.Item name="to" label="Đến ngày giờ (không gồm)" rules={[{ required: true }]}><Input type="datetime-local" aria-label="Đến ngày giờ" /></Form.Item>
        <Form.Item name="entityType" label="Nhóm chức năng"><Select aria-label="Nhóm chức năng" allowClear style={{ width: 180 }} options={Object.entries(entities).map(([value,label]) => ({ value,label }))} /></Form.Item>
        <Form.Item name="action" label="Thao tác"><Select aria-label="Thao tác" allowClear showSearch optionFilterProp="label" style={{ width: 240 }} options={actions.map(value => ({ value,label: actionLabels[value] }))} /></Form.Item>
        <Form.Item name="actorUserId" label="ID người thực hiện"><Input aria-label="ID người thực hiện" maxLength={100} /></Form.Item>
        <Form.Item name="entityId" label="ID đối tượng (chính xác)"><Input aria-label="ID đối tượng" maxLength={100} /></Form.Item>
        <Form.Item name="branchId" label="ID chi nhánh đã ghi nhận"><Input aria-label="ID chi nhánh đã ghi nhận" maxLength={100} /></Form.Item>
      </Space>
      <Space wrap><Button type="primary" htmlType="submit">Tra cứu</Button><Button onClick={() => setRevision(v => v + 1)}>Tải lại</Button></Space>
    </Form>
    {error && <Alert role="alert" type="error" message={error} action={<Button onClick={() => setRevision(v => v + 1)}>Thử lại</Button>} />}
    <Table<AuditEntry> style={{ marginTop: 16 }} rowKey={r => r.source + r.id} loading={loading} dataSource={page?.items ?? []} scroll={{ x: 1100 }} locale={{ emptyText: error ? 'Chưa tải được nhật ký' : <Empty description="Không có nhật ký phù hợp" /> }}
      pagination={{ current: page?.page ?? Number(params.get('page')), pageSize: page?.pageSize ?? Number(params.get('pageSize')), total: page?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10,20,50,100], onChange: (p,s) => { const next = new URLSearchParams(query); next.set('page', String(p)); next.set('pageSize', String(s)); next.delete('log'); next.delete('source'); navigate(next); } }}
      columns={[
        { title: 'Thời điểm (VN)', render: (_,r) => time(r.occurredAt) },
        { title: 'Người thực hiện', render: (_,r) => <span>{r.actorName ? `${r.actorName} (tên hiện tại)` : r.actorUserId ? 'Không có nhãn hiện tại' : 'Không ghi nhận actor'}<br />{r.actorUserId}</span> },
        { title: 'Nhóm / thao tác', render: (_,r) => `${r.entityLabel} · ${r.actionLabel}` },
        { title: 'ID đối tượng', dataIndex: 'entityId' },
        { title: 'Phạm vi đã ghi nhận', render: (_,r) => scopeLabel(r) },
        { title: 'Chi tiết', render: (_,r) => <Button onClick={() => { const next = new URLSearchParams(query); next.set('log',r.id); next.set('source',r.source); navigate(next); }}>Xem nhật ký</Button> },
      ]} />
    <Drawer title="Chi tiết nhật ký" width="min(100vw, 800px)" open={!!detailId} onClose={() => { const next = new URLSearchParams(query); next.delete('log'); next.delete('source'); navigate(next); }}>
      {detailLoading && <Spin />}{detailError && <Alert type="error" message={detailError} action={<Button onClick={() => setRevision(v => v + 1)}>Thử lại</Button>} />}
      {detail && <Space direction="vertical" style={{ width: '100%', overflowWrap: 'anywhere' }}>
        <Descriptions column={1} items={[
          { key: 'source', label: 'Nguồn / mã nhật ký', children: `${detail.source} / ${detail.id}` },
          { key: 'action', label: 'Thao tác', children: detail.actionLabel },
          { key: 'entity', label: detail.entityLabel, children: detail.entityId },
          { key: 'time', label: 'Thời điểm (VN)', children: time(detail.occurredAt) },
          { key: 'actor', label: 'Actor (nhãn hiện tại)', children: `${detail.actorName ?? 'Không có nhãn'} · ${detail.actorUserId ?? 'Không ghi nhận'}` },
          { key: 'scope', label: 'Phạm vi lịch sử', children: scopeLabel(detail) },
          { key: 'reason', label: 'Lý do', children: detail.reason ?? 'Không ghi nhận' },
          { key: 'fields', label: 'Trường đã ghi nhận thay đổi', children: detail.changedFields.map(f => f.label).join(', ') || 'Nguồn không ghi danh sách trường' },
        ]} />
        <Table rowKey="label" pagination={false} dataSource={detail.changes} locale={{ emptyText: 'Không có giá trị trước/sau được ghi nhận và được phép hiển thị' }} columns={[{ title: 'Trường', dataIndex: 'label' }, { title: 'Trước', render: (_,r) => changeValue(r.before) }, { title: 'Sau', render: (_,r) => changeValue(r.after) }]} />
        {detail.objectUrl && <Typography.Link href={detail.objectUrl}>Mở đối tượng</Typography.Link>}
      </Space>}
    </Drawer>
  </main>;
}
