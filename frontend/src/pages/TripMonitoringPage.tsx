import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, Descriptions, Empty, Input, Modal, Pagination, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../api/client';
import { getRealtimeSocket } from '../api/realtime';
import { monitoringApi, MonitoringDetail, MonitoringEvents, MonitoringPage, MonitoringPod, MonitoringRow } from '../api/monitoring';
import MapboxMap from '../components/MapboxMap';
import axios from 'axios';

const labels: Record<string, string> = { DRAFT: 'Nháp', PLANNED: 'Đã lập kế hoạch', DISPATCHED: 'Đã phát hành', IN_PROGRESS: 'Đang chạy', COMPLETED: 'Hoàn tất', CANCELLED: 'Đã hủy', ASSIGNED: 'Đã phân công', ACCEPTED: 'Đã nhận', REJECTED: 'Từ chối', PENDING: 'Chờ xử lý', ARRIVED: 'Đã đến', SKIPPED: 'Bỏ qua', LOAD: 'Lấy hàng', UNLOAD: 'Giao hàng', LOADED: 'Đã lấy/xếp lên xe', NOT_COLLECTED: 'Chưa lấy', ON_VEHICLE: 'Trên xe', UNLOADED: 'Đã dỡ, chưa bàn giao', DELIVERED: 'Đã giao', FAILED: 'Thất bại', UPLOADING: 'Đang xử lý / chưa xác minh', UPLOADED: 'Server đã xác minh', PACKAGE_RELOADED: 'Đã xếp lại', TRIP_STARTED: 'Bắt đầu chuyến', STOP_ARRIVED: 'Đến điểm', PACKAGE_UNLOADED: 'Dỡ kiện', PACKAGE_DELIVERED: 'Bàn giao kiện', PACKAGE_DELIVERY_FAILED: 'Giao thất bại' };
const status = (value: string) => labels[value] || value;
const time = (value: string | null) => value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Chưa ghi nhận';
const errorMessage = (error: unknown) => {
  if (axios.isAxiosError(error) && error.config?.url?.includes('/pod/')) {
    if (error.response?.status === 404) return 'POD: Tệp không còn khả dụng hoặc không thuộc phạm vi được xem.';
    if (error.response?.status === 409) return 'POD: Tệp chưa xác minh hoặc nội dung không khớp chứng cứ đã lưu.';
  }
  return error instanceof Error && /^(Contract|POD:)/.test(error.message) ? error.message : apiErrorMessage(error);
};
const queryFromUrl = () => new URLSearchParams(window.location.search);
const localDate = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + 7 * 3600000).toISOString().slice(0, 16) : '';
function routeGeometry(value: string | null): { type: 'LineString'; coordinates: number[][] } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed) || parsed.type !== 'LineString' || !('coordinates' in parsed) || !Array.isArray(parsed.coordinates)) return null;
    const coordinates = parsed.coordinates;
    if (!coordinates.every((p: unknown): p is number[] => Array.isArray(p) && p.length >= 2 && p.every(n => typeof n === 'number' && Number.isFinite(n)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) return null;
    return { type: 'LineString', coordinates };
  } catch { return null; }
}
function ResourceFilter({ kind, value, onChange }: { kind: 'vehicleId' | 'driverId'; value?: string; onChange: (value?: string) => void }) {
  const [search, setSearch] = useState('');
  const [choices, setChoices] = useState<Array<{ value: string; label: string }>>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => { void monitoringApi.resources(search).then(data => {
      if (!disposed) { setChoices(kind === 'vehicleId' ? data.vehicles.map(v => ({ value: v.id, label: v.plateNumber })) : data.drivers.map(d => ({ value: d.id, label: d.fullName }))); setError(undefined); }
    }).catch(e => { if (!disposed) setError(errorMessage(e)); }); }, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [search, kind]);
  return <div><Select style={{ width: 220 }} aria-label={kind === 'vehicleId' ? 'Lọc xe' : 'Lọc tài xế'} placeholder={kind === 'vehicleId' ? 'Lọc xe' : 'Lọc tài xế'} showSearch filterOption={false} onSearch={setSearch} allowClear value={value} options={choices} onChange={onChange} notFoundContent={error || 'Không có kết quả; nhập để tìm (tối đa 30)'} />{error && <Typography.Text type="danger">{error}</Typography.Text>}</div>;
}

export default function TripMonitoringPage() {
  const { user, branchId, can } = useAuth();
  const [query, setQuery] = useState(queryFromUrl);
  const [data, setData] = useState<MonitoringPage | null>(null);
  const [loadedDetail, setDetail] = useState<MonitoringDetail | null>(null);
  const [events, setEvents] = useState<MonitoringEvents | null>(null);
  const [eventPage, setEventPage] = useState(1);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [subscriptionBranch, setSubscriptionBranch] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [pod, setPod] = useState<MonitoringPod | null>(null);
  const [podUrl, setPodUrl] = useState<string>();
  const [podError, setPodError] = useState<string>();
  const [podRetry, setPodRetry] = useState(0);
  const sequence = useRef(0);
  const tripId = query.get('trip');
  const detail = loadedDetail?.id === tripId ? loadedDetail : null;
  const queryKey = query.toString();
  const navigate = (key: string, value?: string) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page' && key !== 'trip') next.delete('page');
    if (key === 'vehicleId' || key === 'driverId') next.delete('trip');
    window.history.pushState(null, '', '/trips' + (next.size ? '?' + next : ''));
    setPod(null); setEventPage(1); setQuery(next);
  };
  useEffect(() => { const back = () => { setPod(null); setEventPage(1); setQuery(queryFromUrl()); }; window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back); }, []);
  useEffect(() => { setData(null); setDetail(null); setEvents(null); setPod(null); }, [queryKey, branchId, eventPage]);

  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>; let failures = 0;
    const seq = ++sequence.current;
    setError(undefined);
    const load = async () => {
      setBusy(true);
      try {
        if (tripId) {
          const [nextDetail, nextEvents] = await Promise.all([monitoringApi.detail(tripId), monitoringApi.events(tripId, eventPage)]);
          if (disposed || seq !== sequence.current) return;
          if (nextDetail.version !== nextEvents.version) throw new Error('Contract: dữ liệu đang thay đổi, hãy tải lại');
          setDetail(current => !current || nextDetail.version >= current.version ? nextDetail : current); setEvents(nextEvents);
          setSubscriptionBranch(nextDetail.managingBranch?.id);
        } else {
          const params = Object.fromEntries(new URLSearchParams(queryKey));
          const next = await monitoringApi.list({ ...params, branchId, pageSize: 20 });
          if (disposed || seq !== sequence.current) return;
          setData(next);
        }
        setError(undefined); failures = 0;
      } catch (e) {
        if (!disposed && seq === sequence.current) { setError(errorMessage(e)); setDetail(null); setData(null); setEvents(null); setPod(null); failures++; }
      } finally {
        if (!disposed && seq === sequence.current) { setBusy(false); timer = setTimeout(() => void load(), Math.min(60000, 15000 * 2 ** failures)); }
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [tripId, queryKey, branchId, eventPage, refresh]);

  useEffect(() => {
    const socket = getRealtimeSocket(); if (!socket) return;
    const activeBranch = branchId || (tripId ? subscriptionBranch : undefined);
    let disposed = false;
    const join = () => {
      setConnected(false);
      if (!activeBranch) { setRefresh(x => x + 1); return; }
      socket.timeout(5000).emit('join:branch', activeBranch, (err: Error | null, response: unknown) => {
        if (disposed) return;
        const ok = !err && !!response && typeof response === 'object' && 'ok' in response && response.ok === true;
        setConnected(ok); setRefresh(x => x + 1);
      });
    };
    let debounce: ReturnType<typeof setTimeout>;
    const changed = (payload: unknown) => {
      if (!payload || typeof payload !== 'object' || !('id' in payload) || !('version' in payload) || typeof payload.version !== 'number') return;
      if (tripId && payload.id !== tripId) return;
      clearTimeout(debounce); debounce = setTimeout(() => { setPod(null); setRefresh(x => x + 1); }, 200);
    };
    const offline = () => setConnected(false);
    const revoked = () => { setConnected(false); setPod(null); setDetail(null); setData(null); setEvents(null); setRefresh(x => x + 1); };
    socket.on('connect', join); socket.on('disconnect', offline); socket.on('connect_error', offline); socket.on('scope:revoked', revoked); socket.on('trip:updated', changed);
    if (socket.connected) join();
    return () => { disposed = true; clearTimeout(debounce); socket.off('connect', join); socket.off('disconnect', offline); socket.off('connect_error', offline); socket.off('scope:revoked', revoked); socket.off('trip:updated', changed); };
  // Join only when scope changes; versions are handled by reloading authoritative HTTP state.
  }, [branchId, tripId, subscriptionBranch]);

  useEffect(() => {
    let disposed = false; let url: string | undefined;
    setPodUrl(undefined); setPodError(undefined);
    if (pod && tripId) void monitoringApi.pod(tripId, pod.id).then(blob => {
      if (disposed) return; url = URL.createObjectURL(blob); setPodUrl(url);
    }).catch(e => { if (!disposed) setPodError(errorMessage(e)); });
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [pod, tripId, podRetry]);

  const columns = [
    { title: 'Chuyến / chi nhánh', key: 'trip', render: (_: unknown, r: MonitoringRow) => <><Button type="link" onClick={() => navigate('trip', r.id)}>{r.tripNumber}</Button><div>{r.managingBranch?.name || 'Chưa có chi nhánh'}</div></> },
    { title: 'Xe / tài xế', key: 'resources', render: (_: unknown, r: MonitoringRow) => <>{r.vehicle.plateNumber}<div>{r.assignments.map(a => a.driver.fullName + ' · ' + status(a.status)).join(', ') || 'Chưa phân công'}</div></> },
    { title: 'Trạng thái', dataIndex: 'status', render: (s: string) => <Tag>{status(s)}</Tag> },
    { title: 'Kế hoạch (giờ VN)', key: 'planned', render: (_: unknown, r: MonitoringRow) => <>{time(r.plannedStartTime)}<br />{time(r.plannedEndTime)}</> },
    { title: 'Thực tế (giờ VN)', key: 'actual', render: (_: unknown, r: MonitoringRow) => <>{time(r.actualStartTime)}<br />{time(r.actualEndTime)}</> },
    { title: 'Tiến độ', key: 'progress', render: (_: unknown, r: MonitoringRow) => <>{r.completedStopCount}/{r.stopCount} điểm hoàn tất<br />Đã giao {r.deliveredCount}/{r.packageCount} kiện</> },
    { title: 'Cập nhật', dataIndex: 'updatedAt', render: time },
  ];
  return <main id="main-content" style={{ padding: 24, minWidth: 0 }}>
    <Space wrap><Typography.Title level={2}>Tra cứu và giám sát chuyến</Typography.Title><Button onClick={() => setRefresh(x => x + 1)} loading={busy}>Tải lại</Button>{tripId && <Button onClick={() => navigate('trip')}>Quay lại danh sách</Button>}</Space>
    <Alert type={connected ? 'success' : 'warning'} showIcon message={connected ? 'Đã kết nối thông báo thay đổi; dữ liệu lấy từ server' : 'Chưa kết nối thông báo theo chi nhánh; tự tải lại mỗi 15–60 giây'} />
    <Alert style={{ marginTop: 12 }} type="info" message="Chưa có nguồn cập nhật từ ứng dụng tài xế, GPS và tổng kết kết thúc chuyến. Dữ liệu dưới đây là kế hoạch và lịch sử đã lưu." />
    {error && <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} action={<Button onClick={() => setRefresh(x => x + 1)}>Thử lại</Button>} />}
    {!tripId && <>
      <Space wrap style={{ marginBlock: 16 }}>
        <Input.Search aria-label="Tìm mã chuyến, biển số, tài xế" placeholder="Mã chuyến, biển số, tài xế" defaultValue={query.get('search') || ''} key={query.get('search')} onSearch={value => navigate('search', value)} allowClear style={{ width: 280 }} />
        <Select aria-label="Trạng thái chuyến" placeholder="Mọi trạng thái" allowClear style={{ width: 190 }} value={query.get('status') || undefined} onChange={value => navigate('status', value)} options={['DRAFT', 'PLANNED', 'DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].map(value => ({ value, label: status(value) }))} />
        <ResourceFilter kind="vehicleId" value={query.get('vehicleId') || undefined} onChange={value => navigate('vehicleId', value)} />
        <ResourceFilter kind="driverId" value={query.get('driverId') || undefined} onChange={value => navigate('driverId', value)} />
        <Typography.Text>Chi nhánh: {user?.branches.find(b => b.id === branchId)?.name || 'Các chi nhánh được cấp (chọn ở thanh trên)'}</Typography.Text>
        <label>Khởi hành dự kiến từ <input aria-label="Khởi hành dự kiến từ" type="datetime-local" onChange={e => navigate('from', e.target.value ? new Date(e.target.value + '+07:00').toISOString() : undefined)} value={localDate(query.get('from'))} /></label>
        <label>Đến (không gồm) <input aria-label="Khởi hành dự kiến đến" type="datetime-local" onChange={e => navigate('to', e.target.value ? new Date(e.target.value + '+07:00').toISOString() : undefined)} value={localDate(query.get('to'))} /></label>
        {(query.get('vehicleId') || query.get('driverId')) && <Button onClick={() => { const next = new URLSearchParams(query); next.delete('vehicleId'); next.delete('driverId'); next.delete('page'); window.history.pushState(null, '', '/trips?' + next); setQuery(next); }}>Bỏ lọc xe/tài xế</Button>}
      </Space>
      {data && <><Table rowKey="id" dataSource={data.items} columns={columns} scroll={{ x: 1100 }} pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, onChange: p => navigate('page', String(p)) }} /><Typography.Text type="secondary">Tải dữ liệu: {time(data.fetchedAt)}. Đếm kiện riêng biệt có kết quả DELIVERED, không đếm số lần giao.</Typography.Text></>}
    </>}
    {busy && !data && !detail && <Spin aria-label="Đang tải chuyến" style={{ margin: 24 }} />}
    {detail && <>
      <Card title={detail.tripNumber} style={{ marginTop: 16 }}>
        <Descriptions column={{ xs: 1, md: 2 }} items={[
          { key: 'state', label: 'Trạng thái', children: status(detail.status) }, { key: 'branch', label: 'Chi nhánh', children: detail.managingBranch?.name || 'Chưa có' },
          { key: 'vehicle', label: 'Xe', children: <Button type="link" onClick={() => { navigate('vehicleId', detail.vehicle.id); }}>{detail.vehicle.plateNumber}</Button> },
          { key: 'version', label: 'Version hiện tại / nguồn thực thi', children: `${detail.version} / ${detail.snapshot?.sourceTripVersion ?? 'Chưa có snapshot'}` },
          { key: 'planned', label: 'Kế hoạch', children: `${time(detail.plannedStartTime)} → ${time(detail.plannedEndTime)}` },
          { key: 'actual', label: 'Thực tế', children: `${time(detail.actualStartTime)} → ${time(detail.actualEndTime)}` },
          { key: 'updated', label: 'Cập nhật / tải dữ liệu', children: `${time(detail.updatedAt)} / ${time(detail.fetchedAt)}` },
        ]} />
        {detail.assignments.map(a => <Card size="small" key={a.id} title={`${a.driver.fullName} · ${status(a.status)} · ${a.role}`}>
          Kế hoạch: {time(a.startTime)} → {time(a.endTime)}. Phản hồi: {time(a.respondedAt)}. Kết thúc thực tế: {time(a.actualEndTime)}. {a.rejectionReason}
          <Button onClick={() => navigate('driverId', a.driver.id)}>Lọc theo tài xế này</Button>
        </Card>)}
        {can('trips.plan') && <a href="/dispatch-manual">Mở bàn điều phối</a>}
      </Card>
      <Typography.Title level={3}>Kế hoạch và thực tế từng điểm</Typography.Title>
      {routeGeometry(detail.routeGeometry) ? <Card title="Tuyến kế hoạch đã lưu — không phải GPS"><MapboxMap routeGeometry={routeGeometry(detail.routeGeometry)} enableSimulation={false} showControls={false} height={320} /></Card> : <Typography.Paragraph type="secondary">{detail.routeGeometry ? 'Định dạng tuyến đã lưu chưa được màn hình bản đồ hỗ trợ.' : 'Chưa có hình học tuyến đã lưu.'}</Typography.Paragraph>}
      {!detail.stops.length && <Empty description="Chưa có điểm dừng" />}
      <Collapse items={detail.stops.map(stop => ({ key: stop.id, label: `${stop.sequence}. ${stop.address} · ${status(stop.status)}`, children: <>
        <p>Kế hoạch đến/rời: {time(stop.plannedArrivalTime)} → {time(stop.plannedDepartureTime)}</p><p>Thực tế đến/rời: {time(stop.actualArrivalTime)} → {time(stop.actualDepartureTime)}</p>
        {stop.tasks.map(task => <Card key={task.id} size="small" title={`${status(task.action)} · ${task.package?.packageCode || 'Chưa có định danh kiện'}`} style={{ marginBottom: 12 }}>
          <p>Đơn vận tải: {task.order?.orderNumber || 'Chưa xác định'}. Task: {task.id}.</p>
          <p>Số lượng kế hoạch: {task.plannedQuantity}; thực tế: {task.actualQuantity ?? 'Chưa ghi nhận'}.</p>
          {task.orderStop && <p>Khung bắt đầu phục vụ: {time(task.orderStop.windowStart)} → {time(task.orderStop.windowEnd)}; {task.orderStop.serviceDurationMinutes} phút ({task.orderStop.windowBasis || 'Chưa rõ cơ sở'}).</p>}
          <p>Pickup: {task.pickupResult ? `${status(task.pickupResult.outcome)} · ${time(task.pickupResult.event.occurredAt)} · ${task.pickupResult.reason || ''}` : 'Chưa có kết quả pickup ở task này'}.</p>
          <p>Custody: {task.deliveryState ? `${status(task.deliveryState.state)} · ${status(task.deliveryState.lastEvent.eventType)} · ${time(task.deliveryState.lastEvent.occurredAt)}` : 'Chưa có trạng thái delivery; xem bằng chứng pickup, không suy từ trạng thái kiện'}.</p>
          {!task.deliveryResults.length && <Typography.Text type="secondary">Chưa có kết quả giao ở task này.</Typography.Text>}
          {task.deliveryResults.map(result => <div key={result.id} style={{ borderTop: '1px solid #ddd', paddingBlock: 8 }}>
            <Tag>{status(result.result)}</Tag>Lần {result.deliveryAttempt.attemptNumber} · {time(result.deliveryAttempt.occurredAt)}<p>Người nhận: {result.deliveryAttempt.recipientName || 'Chưa ghi nhận'}. {result.reason && `Lý do: ${result.reason}`}</p>
            {!result.deliveryAttempt.podFiles.length && <span>Chưa có POD</span>}
            <Space wrap>{result.deliveryAttempt.podFiles.map(file => <Button key={file.id} disabled={file.uploadStatus !== 'UPLOADED' || !!file.discardedAt} onClick={() => setPod(file)}>{file.discardedAt ? 'POD không còn khả dụng' : file.uploadStatus === 'UPLOADED' ? 'Mở POD đã xác minh' : `POD: ${status(file.uploadStatus)}`}</Button>)}</Space>
          </div>)}
        </Card>)}
      </> }))} />
      <Typography.Title level={3}>Load Plan đã lưu</Typography.Title>
      {detail.loadPlan ? <Collapse items={detail.loadPlan.steps.map(step => ({ key: step.id, label: `Revision ${detail.loadPlan?.revision} · Bước ${step.stepNumber} · ${step.operationType} · ${detail.loadPlan?.validationStatus}`, children: <><p>Task: {step.tasks.map(t => t.id).join(', ')}</p><Table rowKey="packageId" size="small" pagination={false} dataSource={step.placements} scroll={{ x: 650 }} columns={[{ title: 'Package ID', dataIndex: 'packageId' }, { title: 'Vị trí x,y,z (mm)', render: (_, r) => `${r.xMm}, ${r.yMm}, ${r.zMm}` }, { title: 'Kích thước hiệu dụng (mm)', render: (_, r) => `${r.effectiveLengthMm} × ${r.effectiveWidthMm} × ${r.effectiveHeightMm}` }, { title: 'Hướng', dataIndex: 'orientation' }]} /></> }))} /> : <Empty description="Chưa có Load Plan đã lưu" />}
      <Typography.Title level={3}>Lịch sử thực thi</Typography.Title>
      {events && <><Table rowKey="id" pagination={false} dataSource={events.items} scroll={{ x: 850 }} columns={[{ title: 'Sự kiện', dataIndex: 'eventType', render: status }, { title: 'Xảy ra', dataIndex: 'occurredAt', render: time }, { title: 'Server nhận', dataIndex: 'receivedAt', render: time }, { title: 'Stop / task', render: (_, r) => `${r.tripStopId || '—'} / ${r.stopTaskId || '—'}` }, { title: 'Snapshot nguồn', dataIndex: 'sourceSnapshotId', render: v => v || 'Chưa có' }]} /><Pagination current={eventPage} pageSize={events.pageSize} total={events.total} showSizeChanger={false} onChange={setEventPage} /></>}
    </>}
    <Modal title="Bằng chứng giao hàng (POD)" open={!!pod} onCancel={() => setPod(null)} footer={<Button onClick={() => setPod(null)}>Đóng</Button>} destroyOnHidden>
      {podError ? <Alert type="error" message={podError} action={<Button onClick={() => setPodRetry(n => n + 1)}>Tải lại POD</Button>} /> : podUrl ? <img src={podUrl} alt="Bằng chứng giao hàng của lần giao đã chọn" style={{ width: '100%', maxHeight: '65vh', objectFit: 'contain' }} onError={() => setPodError('Không đọc được ảnh POD')} /> : <Spin aria-label="Đang kiểm tra và tải POD" />}
    </Modal>
  </main>;
}
