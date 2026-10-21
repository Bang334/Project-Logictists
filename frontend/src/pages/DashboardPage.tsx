import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Input, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../api/client';
import { dashboardApi, DashboardItem, ItemMetric, issueLabels, Metric, metricLabels } from '../api/dashboard';
import { monitoringApi, MonitoringRow } from '../api/monitoring';
import { getRealtimeSocket } from '../api/realtime';

const time = (v: string | null) => v ? new Date(v).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Chưa ghi nhận';
const labels: Record<string, string> = { DRAFT: 'Nháp', PLANNED: 'Đã lập kế hoạch', DISPATCHED: 'Đã phát hành', IN_PROGRESS: 'Đang thực hiện', COMPLETED: 'Hoàn tất', CANCELLED: 'Đã hủy' };
const localTime = (v: string) => Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v) + 7 * 3600000).toISOString().slice(0, 16) : '';
const initialQuery = () => {
  const q = new URLSearchParams(window.location.search);
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  if (!q.has('from')) q.set('from', new Date(today + 'T00:00:00+07:00').toISOString());
  if (!q.has('to')) q.set('to', new Date(Date.parse(today + 'T00:00:00+07:00') + 86400000).toISOString());
  return q;
};
const message = (e: unknown) => e instanceof Error && e.message.startsWith('Contract') ? e.message : apiErrorMessage(e);

// Each section fails independently. Keep only same-query data on a transient
// error; discard previous data on scope/query changes and authorization errors.
function useSnapshot<T>(key: string, refresh: number, load: () => Promise<T>, enabled = true) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string; busy: boolean }>({ key, busy: enabled });
  const loader = useRef(load); loader.current = load;
  useEffect(() => {
    let disposed = false;
    if (!enabled) { setState({ key, busy: false }); return; }
    setState(old => ({ key, data: old.key === key ? old.data : undefined, error: old.key === key ? old.error : undefined, busy: true }));
    void loader.current().then(data => { if (!disposed) setState({ key, data, busy: false }); }).catch(e => {
      if (!disposed) setState(old => ({ key, data: axios.isAxiosError(e) && [401, 403].includes(e.response?.status || 0) ? undefined : old.key === key ? old.data : undefined, error: message(e), busy: false }));
    });
    return () => { disposed = true; };
  }, [key, refresh, enabled]);
  return state.key === key ? state : { key, busy: enabled };
}

export default function DashboardPage({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { user, branchId, setBranchId, can, scopeVersion } = useAuth();
  const [query, setQuery] = useState(initialQuery);
  const [refresh, setRefresh] = useState(0), [securityEpoch, setSecurityEpoch] = useState(0);
  const [connected, setConnected] = useState(false), [paused, setPaused] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const failures = useRef(0);
  const from = query.get('from') || '', to = query.get('to') || '';
  const validRange = Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) && Date.parse(from) < Date.parse(to) && Date.parse(to) - Date.parse(from) <= 366 * 86400000;
  const scope = `${user?.id}:${scopeVersion}:${branchId}:${securityEpoch}`;
  const queryKey = query.toString();
  const itemValue = query.get('metric') || 'candidateOrders';
  const itemMetric: ItemMetric = ['candidateOrders', 'availableVehicles', 'availableDrivers', ...Object.keys(issueLabels)].includes(itemValue) ? itemValue as ItemMetric : 'candidateOrders';
  const issueValue = query.get('issue') || 'reviewOrders';
  const issue: keyof typeof issueLabels = Object.prototype.hasOwnProperty.call(issueLabels, issueValue) ? issueValue as keyof typeof issueLabels : 'reviewOrders';
  const page = (name: string) => { const n = Number(query.get(name) || 1); return Number.isInteger(n) && n > 0 && n <= 100000 ? n : 1; };
  const permission = (metric: ItemMetric) => metric.endsWith('Orders') ? 'orders.read' : metric.endsWith('Drivers') ? 'drivers.read' : 'vehicles.read';
  const tripMode = query.get('tripMode') || 'current';
  const tripStatus = query.get('status') || undefined;
  const tripParams = {
    branchId, page: page('tripPage'), pageSize: 10,
    status: tripMode === 'completed' ? 'COMPLETED' : tripStatus,
    ...(tripMode === 'current' ? {} : { from, to, timeBasis: tripMode === 'departed' ? 'actualStartTime' : tripMode === 'completed' ? 'actualEndTime' : 'plannedStartTime' }),
  };
  const summary = useSnapshot(`${scope}:${from}:${to}`, refresh, () => dashboardApi.summary({ from, to, branchId }), !blocked && validRange);
  const details = useSnapshot(`${scope}:${itemMetric}:${page('itemPage')}`, refresh, () => dashboardApi.items({ metric: itemMetric, page: page('itemPage'), branchId }), !blocked && can(permission(itemMetric)));
  const issues = useSnapshot(`${scope}:${issue}:${page('issuePage')}`, refresh, () => dashboardApi.items({ metric: issue, page: page('issuePage'), branchId }), !blocked && can(permission(issue)));
  const trips = useSnapshot(`${scope}:${JSON.stringify(tripParams)}`, refresh, () => monitoringApi.list(tripParams), !blocked && can('trips.read') && (tripMode === 'current' || validRange));
  const navigate = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    window.history.pushState(null, '', '/?' + next); setQuery(next);
  };
  const reload = () => { failures.current = 0; setPaused(false); setBlocked(false); setRefresh(n => n + 1); };
  useEffect(() => {
    window.history.replaceState(null, '', '/?' + queryKey);
    const back = () => setQuery(initialQuery());
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [queryKey]);
  useEffect(() => {
    if (blocked) return;
    if (summary.busy || trips.busy || details.busy || issues.busy) return;
    if (summary.error || trips.error || details.error || issues.error) failures.current++;
    else { failures.current = 0; setPaused(false); }
    if (failures.current >= 3) { setPaused(true); return; }
    const timer = setTimeout(() => { if (!document.hidden) setRefresh(n => n + 1); }, Math.min(60000, 30000 * 2 ** failures.current));
    const visible = () => { if (!document.hidden) setRefresh(n => n + 1); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [summary.busy, trips.busy, details.busy, issues.busy, summary.error, trips.error, details.error, issues.error, refresh, blocked]);
  const canReadTrips = can('trips.read');
  useEffect(() => {
    const socket = getRealtimeSocket(); if (!socket) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { if (!timer) timer = setTimeout(() => { timer = undefined; setRefresh(n => n + 1); }, 300); };
    const join = () => {
      setConnected(false); changed();
      if (branchId && canReadTrips) socket.timeout(5000).emit('join:branch', branchId, (err: Error | null, response: unknown) => {
        if (!disposed) setConnected(!err && !!response && typeof response === 'object' && 'ok' in response && response.ok === true);
      });
    };
    const offline = () => setConnected(false);
    const revoke = () => { setSecurityEpoch(n => n + 1); setBlocked(true); setConnected(false); };
    socket.on('connect', join); socket.on('disconnect', offline); socket.on('trip:updated', changed); socket.on('scope:revoked', revoke);
    window.addEventListener('tms:forbidden', revoke);
    if (socket.connected) join();
    return () => { disposed = true; clearTimeout(timer); socket.off('connect', join); socket.off('disconnect', offline); socket.off('trip:updated', changed); socket.off('scope:revoked', revoke); window.removeEventListener('tms:forbidden', revoke); };
  }, [branchId, scopeVersion, user?.id, canReadTrips]);
  const choose = (metric: Metric) => {
    if (metric.endsWith('Trips')) {
      navigate({ tripMode: metric === 'departedTrips' ? 'departed' : metric === 'completedTrips' ? 'completed' : 'current',
        status: ({ plannedTrips: 'PLANNED', dispatchedTrips: 'DISPATCHED', activeTrips: 'IN_PROGRESS' } as Record<string, string>)[metric], tripPage: undefined });
      document.getElementById('dashboard-trips')?.scrollIntoView({ block: 'start' });
    } else navigate({ metric, itemPage: undefined });
  };
  const openItem = (r: DashboardItem) => onNavigate(r.kind === 'order' ? 'orders?order=' + r.id : 'fleet?kind=' + (r.kind === 'vehicle' ? 'vehicles' : 'drivers') + '&resource=' + r.id);
  const error = (text?: string, stale = false) => text && <Alert type="error" showIcon message={`${stale ? 'Dữ liệu cũ — ' : ''}${text}`} action={<Button onClick={reload}>Thử lại</Button>} />;
  const itemColumns = [
    { title: 'Đối tượng / chi nhánh', key: 'object', render: (_: unknown, r: DashboardItem) => <><Button type="link" onClick={() => openItem(r)}>{r.label}</Button><div>{r.branch}</div></> },
    { title: 'Trạng thái nguồn', dataIndex: 'status' },
    { title: 'Căn cứ', dataIndex: 'evidence' },
    { title: 'Thời điểm căn cứ', dataIndex: 'evidenceAt', render: time },
  ];
  return <main id="main-content" style={{ padding: 20, minWidth: 0 }}>
    <Typography.Title level={2}>Dashboard vận hành vận tải</Typography.Title>
    <Space wrap style={{ marginBottom: 16 }}>
      <Select aria-label="Chi nhánh Dashboard" value={branchId || 'ALL'} style={{ width: 250, maxWidth: '100%' }} onChange={v => setBranchId(v === 'ALL' ? undefined : v)} options={[{ value: 'ALL', label: 'Tất cả chi nhánh được cấp' }, ...(user?.branches || []).map(b => ({ value: b.id, label: b.name }))]} />
      <label>Từ (gồm)<Input aria-label="Từ ngày giờ" type="datetime-local" value={localTime(from)} onChange={e => { if (e.target.value) navigate({ from: new Date(e.target.value + '+07:00').toISOString(), tripPage: undefined }); }} /></label>
      <label>Đến (không gồm)<Input aria-label="Đến ngày giờ" type="datetime-local" value={localTime(to)} onChange={e => { if (e.target.value) navigate({ to: new Date(e.target.value + '+07:00').toISOString(), tripPage: undefined }); }} /></label>
      <Button onClick={reload} loading={summary.busy || trips.busy}>Làm mới</Button>
    </Space>
    <Typography.Paragraph>Giờ vận hành: Asia/Ho_Chi_Minh (UTC+7). Kỳ lọc tối đa 366 ngày. Các chỉ số hiện tại không lọc ngày tạo.</Typography.Paragraph>
    {!validRange && <Alert type="error" message="Khoảng ngày giờ không hợp lệ: cần từ < đến, tối đa 366 ngày." />}
    {blocked && <Alert type="error" message="Quyền truy cập đã thay đổi. Dữ liệu đã được xóa; đang xác minh lại phạm vi." />}
    <Alert type="info" message={connected ? 'Đã kết nối thông báo chuyến; API là nguồn dữ liệu. Hồ sơ/đơn được tải lại định kỳ.' : 'Snapshot từ server; tự tải lại mỗi 30–60 giây khi trang hiển thị.'} description="Chưa tích hợp nguồn mobile, GPS và tổng kết kết thúc chuyến hiện hành. Số liệu actual chỉ phản ánh mốc đã lưu; Trip hoàn tất không chứng minh mọi kiện đã giao." />
    {paused && <Alert type="warning" message="Đã dừng tự thử sau 3 lần lỗi. Chọn Làm mới để tiếp tục." />}
    <Typography.Title level={3}>Tổng quan</Typography.Title>
    {error(summary.error, !!summary.data)}
    <Typography.Paragraph>{summary.data ? `Cập nhật tổng hợp: ${time(summary.data.fetchedAt)}` : 'Chưa có snapshot tổng hợp'}</Typography.Paragraph>
    <Row gutter={[12, 12]}>
      {(Object.keys(metricLabels) as Metric[]).map(metric => <Col xs={24} sm={12} xl={6} key={metric}>
        <Card size="small" loading={summary.busy && !summary.data}>
          <Tag>{['departedTrips', 'completedTrips'].includes(metric) ? 'Trong kỳ lọc' : 'Hiện tại'}</Tag>
          <Statistic title={metricLabels[metric]} value={summary.data?.metrics[metric] ?? '—'} />
          <Typography.Paragraph type="secondary">{metric === 'candidateOrders' ? 'Cần kiểm tra kiện, khung giờ và khả năng điều phối.' : metric.includes('available') ? 'Trạng thái quản lý, chưa chứng nhận đủ điều kiện nhận chuyến.' : metric === 'completedTrips' ? 'Đã hoàn tất và có thời điểm kết thúc thực tế trong kỳ.' : metric === 'departedTrips' ? 'Có thời điểm bắt đầu thực tế trong kỳ; mọi trạng thái.' : 'Trạng thái chuyến tại thời điểm cập nhật.'}</Typography.Paragraph>
          {summary.data?.metrics[metric] === null ? <span>Không có quyền trong phạm vi</span> : <Button style={{ whiteSpace: 'normal', height: 'auto' }} disabled={!summary.data} onClick={() => choose(metric)}>Đối chiếu {metricLabels[metric]}</Button>}
        </Card>
      </Col>)}
    </Row>
    {!!summary.data?.missingCompletionTime && <Alert style={{ marginTop: 12 }} type="warning" message={`${summary.data.missingCompletionTime} chuyến hoàn tất thiếu thời điểm kết thúc thực tế trong toàn phạm vi hiện tại; chưa xác định thuộc kỳ nào, không tính vào số hoàn tất trong kỳ.`} />}
    <Card style={{ marginTop: 20 }} title="Đối chiếu đơn / tài nguyên">
      <Select aria-label="Danh sách đối chiếu" value={itemMetric} style={{ width: '100%', maxWidth: 420, marginBottom: 12 }} onChange={metric => navigate({ metric, itemPage: undefined })} options={(['candidateOrders', 'availableVehicles', 'availableDrivers'] as const).map(value => ({ value, label: metricLabels[value] }))} />
      {error(details.error, !!details.data)}
      {!can(permission(itemMetric)) ? <Empty description="Không có quyền xem danh sách này" /> : <>
        <Typography.Paragraph>Snapshot: {details.data ? time(details.data.fetchedAt) : 'Chưa có'} · Tổng: {details.data?.total ?? '—'}</Typography.Paragraph>
        <Table rowKey="id" loading={details.busy} dataSource={details.data?.items} columns={itemColumns} scroll={{ x: 800 }} locale={{ emptyText: details.error ? 'Không tải được dữ liệu' : 'Không có đối tượng trong phạm vi' }} pagination={{ current: page('itemPage'), total: details.data?.total || 0, pageSize: 20, showSizeChanger: false, onChange: p => navigate({ itemPage: String(p) }) }} />
      </>}
    </Card>
    <Card style={{ marginTop: 20 }} title="Vấn đề cần xem xét — hiện tại">
      <Space wrap>{(Object.keys(issueLabels) as Array<keyof typeof issueLabels>).map(value => <Button key={value} style={{ whiteSpace: 'normal', height: 'auto' }} type={issue === value ? 'primary' : 'default'} disabled={!can(permission(value))} onClick={() => navigate({ issue: value, issuePage: undefined })}>{issueLabels[value]}: {summary.data?.issues[value] ?? '—'}</Button>)}</Space>
      <Typography.Paragraph style={{ marginTop: 12 }}>Căn cứ hồ sơ/lịch đã lưu; không suy nguy cơ thành vi phạm thực tế. Chưa có nguồn kết luận xung đột chuyến, giao thất bại chưa xử lý hoặc GPS cũ.</Typography.Paragraph>
      {error(issues.error, !!issues.data)}
      <Typography.Paragraph>Snapshot: {issues.data ? time(issues.data.fetchedAt) : 'Chưa có'} · Tổng: {issues.data?.total ?? '—'}</Typography.Paragraph>
      {can(permission(issue)) ? <Table rowKey="id" loading={issues.busy} dataSource={issues.data?.items} columns={itemColumns} scroll={{ x: 800 }} locale={{ emptyText: issues.error ? 'Không tải được dữ liệu' : 'Không có vấn đề thuộc nhóm này' }} pagination={{ current: page('issuePage'), total: issues.data?.total || 0, pageSize: 20, showSizeChanger: false, onChange: p => navigate({ issuePage: String(p) }) }} /> : <Empty description="Không có quyền xem nhóm này" />}
    </Card>
    <Card id="dashboard-trips" style={{ marginTop: 20 }} title="Chuyến vận hành">
      <Space wrap style={{ marginBottom: 12 }}>
        <Select aria-label="Mốc lọc chuyến" value={tripMode} style={{ width: 275, maxWidth: '100%' }} onChange={v => navigate({ tripMode: v, tripPage: undefined, status: undefined })} options={[{ value: 'current', label: 'Trạng thái hiện tại — không lọc kỳ' }, { value: 'planned', label: 'Khởi hành kế hoạch trong kỳ' }, { value: 'departed', label: 'Khởi hành thực tế trong kỳ' }, { value: 'completed', label: 'COMPLETED + kết thúc thực tế trong kỳ' }]} />
        <Select aria-label="Trạng thái chuyến Dashboard" allowClear disabled={tripMode === 'completed'} placeholder="Mọi trạng thái" value={tripMode === 'completed' ? 'COMPLETED' : tripStatus} style={{ width: 210 }} options={Object.entries(labels).map(([value, label]) => ({ value, label }))} onChange={v => navigate({ status: v, tripPage: undefined })} />
      </Space>
      {error(trips.error, !!trips.data)}
      <Typography.Paragraph>Snapshot: {trips.data ? time(trips.data.fetchedAt) : 'Chưa có'} · Tổng: {trips.data?.total ?? '—'}</Typography.Paragraph>
      {!can('trips.read') ? <Empty description="Không có quyền xem chuyến" /> : <Table<MonitoringRow> rowKey="id" loading={trips.busy} dataSource={trips.data?.items} scroll={{ x: 1200 }} pagination={{ current: page('tripPage'), total: trips.data?.total || 0, pageSize: 10, showSizeChanger: false, onChange: p => navigate({ tripPage: String(p) }) }} locale={{ emptyText: trips.error ? 'Không tải được dữ liệu' : 'Không có chuyến khớp bộ lọc' }} columns={[
        { title: 'Chuyến / chi nhánh', render: (_, r) => <><Button type="link" onClick={() => onNavigate('trips?trip=' + r.id)}>{r.tripNumber}</Button><div>{r.managingBranch?.name || 'Chưa ghi nhận'}</div></> },
        { title: 'Xe / tài xế', render: (_, r) => <>{r.vehicle.plateNumber}<div>{r.assignments.map(a => a.driver.fullName + ' (' + a.status + ')').join(', ') || 'Chưa phân công'}</div></> },
        { title: 'Trạng thái', render: (_, r) => labels[r.status] || r.status },
        { title: 'Kế hoạch bắt đầu / kết thúc', render: (_, r) => <>{time(r.plannedStartTime)}<br />{time(r.plannedEndTime)}</> },
        { title: 'Thực tế bắt đầu / kết thúc', render: (_, r) => <>{time(r.actualStartTime)}<br />{time(r.actualEndTime)}</> },
        { title: 'Tiến độ đã ghi nhận', render: (_, r) => <>{r.stopCount ? `${r.completedStopCount}/${r.stopCount} điểm hoàn tất` : 'Chưa có điểm dừng'}<br />{r.packageCount ? `${r.deliveredCount}/${r.packageCount} kiện có ghi nhận đã giao` : 'Chưa có danh sách kiện'}</> },
        { title: 'Cập nhật chuyến', dataIndex: 'updatedAt', render: time },
      ]} />}
    </Card>
  </main>;
}
