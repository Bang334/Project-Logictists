import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, DatePicker, Descriptions, Drawer, Input, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import dayjs, { Dayjs } from 'dayjs';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage, branchesApi } from '../api/client';
import { fleetApi } from '../api/fleet';
import { Availability, editDriver, editVehicle, FleetKind, FleetProfile, profile } from '../types/fleet';
import type { Branch, Driver, Vehicle } from '../types';
import { EditDriverModal } from '../components/EditDriverModal';
import { EditVehicleModal } from '../components/EditVehicleModal';
import { EditBranchModal } from '../components/EditBranchModal';
import { CreateFleetModal } from '../components/CreateFleetModal';
import { FleetSchedulePanel, pickerUtc } from '../components/FleetSchedulePanel';
const reasons: Record<string, string> = { EMPLOYEE_LINK_MISSING: 'Chưa liên kết Employee', EMPLOYEE_BRANCH_MISMATCH: 'Chi nhánh Employee chưa khớp', PROFILE_NOT_ACTIVE: 'Hồ sơ chưa sẵn sàng', VEHICLE_PROFILE_INCOMPLETE: 'Thiếu cấu hình/điểm xuất phát', DOOR_AND_OBSTACLE_DATA_UNVERIFIED: 'Cửa/vật cản chưa được kiểm chứng', SHIFT_NOT_COVERING_INTERVAL: 'Ca chưa phủ toàn khoảng', EMPLOYEE_LEAVE: 'Có lịch nghỉ', VEHICLE_UNAVAILABILITY: 'Có lịch xe không khả dụng', RESERVED_OR_ASSIGNED: 'Đã giữ lịch/phân công', LICENSE_EXPIRES_BEFORE_WORK_END: 'Bằng hết hạn trước khi kết thúc' };
const label = (r: FleetProfile) => r.plateNumber ?? r.fullName ?? r.id;
export default function FleetPage() {
  const { can, branchId, setBranchId } = useAuth();
  const [kind, setKind] = useState<FleetKind>(() => new URLSearchParams(window.location.search).get('kind') === 'drivers' ? 'drivers' : 'vehicles'), [tab, setTab] = useState<string>(() => new URLSearchParams(window.location.search).get('kind') === 'drivers' ? 'drivers' : 'vehicles');
  const [branches, setBranches] = useState<Branch[]>([]), [rows, setRows] = useState<FleetProfile[]>([]), [total, setTotal] = useState(0);
  const [page, setPage] = useState(1), [search, setSearch] = useState(''), [status, setStatus] = useState<string>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('day'), dayjs().endOf('day')]);
  const [availability, setAvailability] = useState<Availability[]>([]), [availabilityMode, setAvailabilityMode] = useState(false);
  const [selected, setSelected] = useState<FleetProfile | null>(null), [creating, setCreating] = useState(false), [linking, setLinking] = useState(false);
  const [editV, setEditV] = useState<Vehicle | null>(null), [editD, setEditD] = useState<Driver | null>(null), [editB, setEditB] = useState<Branch | null>(null);
  const request = useRef(0);
  useEffect(() => {
    let disposed = false;
    const id = new URLSearchParams(window.location.search).get('resource');
    if (id) void fleetApi.detail(kind, id).then(raw => { if (!disposed) setSelected(profile(raw)); }).catch(e => { if (!disposed) setError(apiErrorMessage(e)); });
    return () => { disposed = true; };
  }, [kind, branchId]);
  const fetchRows = useCallback(async () => {
    const seq = ++request.current; setLoading(true); setError('');
    try { const params = { branchId, search, status, page, pageSize: 20 };
      const [b, data] = await Promise.all([branchesApi.getAll(), availabilityMode ? fleetApi.availability(kind, { ...params, startsAt: pickerUtc(range[0]), endsAt: pickerUtc(range[1]) }) : fleetApi.list(kind, params)]);
      if (seq !== request.current) return; setBranches(b.data); setTotal(data.total);
      if (availabilityMode) { const a = data.items.filter((item): item is Availability => 'resourceId' in item); setAvailability(a); setRows(a.map(item => item.profile)); }
      else { setRows(data.items.filter((item): item is FleetProfile => 'id' in item)); setAvailability([]); }
    } catch (e) { if (seq === request.current) { setRows([]); setAvailability([]); setError(apiErrorMessage(e)); } } finally { if (seq === request.current) setLoading(false); }
  }, [branchId, search, status, page, availabilityMode, kind, range]);
  useEffect(() => { const counter = request; void fetchRows(); return () => { counter.current++; }; }, [fetchRows]);
  const open = async (row: FleetProfile, edit = false) => { setError(''); try { const raw = await fleetApi.detail(kind, row.id); const p = profile(raw); if (edit) { if (kind === 'vehicles') setEditV(editVehicle(raw)); else setEditD(editDriver(raw)); } else setSelected(p); } catch (e) { setError(apiErrorMessage(e)); } };
  const changed = async () => { await fetchRows(); if (selected) { try { setSelected(profile(await fleetApi.detail(kind, selected.id))); } catch (e) { setSelected(null); setError(apiErrorMessage(e)); } } };
  return <div className="tms-page"><Typography.Title level={3}>Xe, tài xế và lịch khả dụng</Typography.Title>
    <Space wrap style={{ marginBottom: 16 }}>
      <Select aria-label="Chi nhánh quản lý" value={branchId ?? 'ALL'} style={{ width: 240 }} onChange={v => { setBranchId(v === 'ALL' ? undefined : v); setPage(1); }} options={[{ value: 'ALL', label: 'Tất cả chi nhánh được cấp' }, ...branches.map(b => ({ value: b.id, label: b.name }))]} />
      <Button onClick={() => void fetchRows()} loading={loading}>Làm mới</Button>
      {tab !== 'branches' && can(`${kind}.manage`) && <Button type="primary" onClick={() => setCreating(true)}>Tạo {kind === 'vehicles' ? 'xe' : 'tài xế'}</Button>}
    </Space>
    {error && <Alert style={{ marginBottom: 12 }} type="error" message={error} action={<Button onClick={() => void fetchRows()}>Thử lại</Button>} />}
    <Card><Tabs activeKey={tab} onChange={v => { setTab(v); if (v !== 'branches') setKind(v as FleetKind); setPage(1); setSearch(''); setStatus(undefined); setSelected(null); setRows([]); }} items={[{ key: 'vehicles', label: 'Xe' }, { key: 'drivers', label: 'Tài xế' }, { key: 'branches', label: 'Chi nhánh' }]} />
      {tab === 'branches' ? <Table<Branch> rowKey="id" dataSource={branches} scroll={{ x: 500 }} columns={[{ title: 'Mã', dataIndex: 'code' }, { title: 'Tên', dataIndex: 'name' }, { title: 'Địa chỉ quản lý', dataIndex: 'address' }, { title: 'Thao tác', render: (_, b) => <Button disabled={!can('branches.manage')} onClick={() => setEditB(b)}>Sửa</Button> }]} /> : <>
        <Space wrap style={{ marginBottom: 12 }}><Input.Search aria-label="Tìm hồ sơ" placeholder={kind === 'vehicles' ? 'Biển số, dòng xe' : 'Tên, điện thoại'} allowClear onSearch={s => { setSearch(s); setPage(1); }} style={{ width: 240 }} />
          <Select aria-label="Trạng thái" allowClear placeholder="Tất cả trạng thái" value={status} style={{ width: 190 }} onChange={v => { setStatus(v); setPage(1); }} options={(kind === 'vehicles' ? ['AVAILABLE', 'ON_TRIP', 'MAINTENANCE', 'DECOMMISSIONED'] : ['AVAILABLE', 'ON_DUTY', 'ON_LEAVE', 'RESTING']).map(s => ({ value: s, label: s }))} />
          <Button type={availabilityMode ? 'primary' : 'default'} onClick={() => { setAvailabilityMode(v => !v); setPage(1); }}>Tra cứu theo thời gian</Button>
        </Space>
        {availabilityMode && <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}><DatePicker.RangePicker aria-label="Khoảng tra cứu" showTime value={range} format="DD/MM/YYYY HH:mm" onChange={r => { if (r?.[0] && r[1]) { setRange([r[0], r[1]]); setPage(1); } }} /><Alert type="info" message="Giờ Việt Nam (UTC+7). Snapshot hồ sơ/lịch chưa xác minh vị trí thực tế, thời gian đến nhận việc, giờ lái/nghỉ, tương thích bằng và xếp/dỡ. Phân công phải kiểm tra lại." /></Space>}
        <Table<FleetProfile> rowKey="id" loading={loading} dataSource={rows} scroll={{ x: 780 }} pagination={{ current: page, total, pageSize: 20, onChange: setPage, showSizeChanger: false }} columns={[
          { title: kind === 'vehicles' ? 'Xe' : 'Tài xế', render: (_, r) => <Button type="link" onClick={() => void open(r)}>{label(r)}</Button> },
          { title: 'Chi nhánh quản lý', render: (_, r) => r.homeBranch?.name },
          { title: kind === 'vehicles' ? 'Cấu hình' : 'Giấy phép', render: (_, r) => kind === 'vehicles' ? `${r.payloadCapacityKg} kg · ${r.lengthCm} × ${r.widthCm} × ${r.heightCm} cm` : <>{r.licenseClass} · {r.licenseExpiry?.slice(0, 10)}{!r.employeeId && <Tag color="orange">Thiếu Employee</Tag>}</> },
          { title: 'Trạng thái hồ sơ', dataIndex: 'status' },
          ...(availabilityMode ? [{ title: 'Kết quả tra cứu', render: (_: unknown, r: FleetProfile) => { const a = availability.find(item => item.resourceId === r.id); return a ? <Space direction="vertical"><span>Hồ sơ: {a.profileActive ? 'sẵn sàng' : 'chưa sẵn sàng'} · Dữ liệu: {a.dataComplete ? 'có trường cơ bản' : 'thiếu'}</span><span>Ca: {a.scheduleCovered === null ? 'không áp dụng cho xe' : a.scheduleCovered ? 'phủ khoảng' : 'chưa phủ'}</span>{a.reasons.map(reason => <Tag key={reason} color="orange">{reasons[reason] ?? reason}</Tag>)}{a.affectedTrips.map(t => <span key={t.id}>Chuyến {t.tripNumber} ({t.status})</span>)}</Space> : null; } }] : []),
          { title: 'Thao tác', render: (_, r) => <Space><Button onClick={() => void open(r)}>Chi tiết / lịch</Button>{can(`${kind}.manage`) && <Button onClick={() => void open(r, true)}>Sửa</Button>}</Space> },
        ]} />
      </>}
    </Card>
    <Drawer open={!!selected} title={selected ? label(selected) : ''} onClose={() => setSelected(null)} width="min(100vw, 1000px)">{selected && <Space direction="vertical" style={{ width: '100%' }}><Descriptions column={1} items={[{ key: 'id', label: 'ID', children: selected.id }, { key: 'branch', label: 'Chi nhánh', children: selected.homeBranch?.name }, { key: 'version', label: 'Phiên bản hồ sơ', children: selected.updatedAt }, { key: 'contact', label: 'Liên hệ / dòng xe', children: selected.phone ?? selected.model }]} />
      {kind === 'drivers' && !selected.employeeId && can('drivers.manage') && <Button onClick={() => setLinking(true)}>Liên kết Employee</Button>}
      <FleetSchedulePanel key={selected.id} kind={kind} resource={selected} canManage={can(`${kind}.manage`)} onChanged={() => void changed()} />
    </Space>}</Drawer>
    {creating && <CreateFleetModal kind={kind} branches={branches} onClose={() => setCreating(false)} onSaved={() => void fetchRows()} />}
    {linking && selected && <CreateFleetModal kind="drivers" branches={branches} linkDriver={selected} onClose={() => setLinking(false)} onSaved={() => void changed()} />}
    <EditVehicleModal open={!!editV} vehicle={editV} branches={branches} onCancel={() => setEditV(null)} onSuccess={() => void changed()} />
    <EditDriverModal open={!!editD} driver={editD} branches={branches} onCancel={() => setEditD(null)} onSuccess={() => void changed()} />
    <EditBranchModal open={!!editB} branch={editB} onCancel={() => setEditB(null)} onSuccess={() => void fetchRows()} />
  </div>;
}
