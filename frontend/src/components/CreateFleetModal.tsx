import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, DatePicker, Form, Input, Modal, Select, Space } from 'antd';
import type { Dayjs } from 'dayjs';
import { apiErrorMessage, locationsApi, vehiclesApi } from '../api/client';
import { fleetApi, fleetFieldErrors } from '../api/fleet';
import type { Branch, Location, VehicleType } from '../types';
import type { FleetEmployee, FleetKind, FleetProfile } from '../types/fleet';

export function CreateFleetModal({ kind, branches, linkDriver, onClose, onSaved }: { kind: FleetKind; branches: Branch[]; linkDriver?: FleetProfile; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm(); const { message } = App.useApp();
  const [types, setTypes] = useState<VehicleType[]>([]), [locations, setLocations] = useState<Location[]>([]), [employees, setEmployees] = useState<FleetEmployee[]>([]);
  const [search, setSearch] = useState(''), [employeePage, setEmployeePage] = useState(1), [employeeTotal, setEmployeeTotal] = useState(0);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [retry, setRetry] = useState(0);
  const pending = useRef(false), key = useRef(crypto.randomUUID()), previousPayload = useRef('');
  const branch = Form.useWatch('homeBranchId', form);
  useEffect(() => { let current = true; setLoading(true); setError('');
    const load = async () => {
      try {
        if (kind === 'vehicles') { const [t, l] = await Promise.all([vehiclesApi.getTypes(), locationsApi.getAll()]); if (current) { setTypes(t.data); setLocations(l.data); } }
        else { const r = await fleetApi.employees({ search, page: employeePage, pageSize: 25 }); if (current) { setEmployees(r.items); setEmployeeTotal(r.total); } }
      } catch (e) { if (current) setError(apiErrorMessage(e)); } finally { if (current) setLoading(false); }
    }; void load(); return () => { current = false; };
  }, [kind, search, employeePage, retry]);
  const save = async (values: { plateNumber?: string; model?: string; homeBranchId?: string; homeDepotLocationId?: string; vehicleTypeId?: string; employeeId?: string; licenseNumber?: string; licenseClass?: string; licenseExpiry?: Dayjs }) => {
    if (pending.current) return; pending.current = true; setSaving(true); setError('');
    try {
      let data: Record<string, unknown>;
      if (kind === 'vehicles') data = { ...values };
      else { const e = employees.find(row => row.id === values.employeeId); if (!e) throw new Error('Chọn lại nhân viên trong danh sách đang xem');
        data = linkDriver ? { employeeId: e.id, employeeVersion: e.version, expectedUpdatedAt: linkDriver.updatedAt } : { employeeId: e.id, employeeVersion: e.version, licenseNumber: values.licenseNumber, licenseClass: values.licenseClass, licenseExpiry: values.licenseExpiry?.format('YYYY-MM-DD') };
      }
      const serialized = JSON.stringify(data); if (previousPayload.current && previousPayload.current !== serialized) key.current = crypto.randomUUID(); previousPayload.current = serialized;
      if (linkDriver) await fleetApi.link(linkDriver.id, data, key.current); else await fleetApi.create(kind, data, key.current);
      message.success('Đã lưu hồ sơ'); onSaved(); onClose();
    } catch (e) { form.setFields(fleetFieldErrors(e)); setError(e instanceof Error && !('response' in e) ? e.message : apiErrorMessage(e)); } finally { pending.current = false; setSaving(false); }
  };
  return <Modal open title={linkDriver ? 'Liên kết Employee đã đối chiếu' : kind === 'vehicles' ? 'Tạo xe' : 'Tạo tài xế từ Employee'} onCancel={onClose} onOk={() => form.submit()} okText="Lưu hồ sơ" cancelText="Đóng" confirmLoading={saving} okButtonProps={{ disabled: loading }}>
    {error && <Alert type="error" message={error} action={<Button onClick={() => setRetry(n => n + 1)}>Tải lại lựa chọn</Button>} />}
    <Form form={form} layout="vertical" onFinish={save}>
      {kind === 'vehicles' ? <>
        <Form.Item name="plateNumber" label="Biển số" rules={[{ required: true }, { max: 30 }]}><Input /></Form.Item>
        <Form.Item name="model" label="Dòng xe" rules={[{ required: true }, { max: 200 }]}><Input /></Form.Item>
        <Form.Item name="vehicleTypeId" label="Loại xe — tải và số đo dùng chung" rules={[{ required: true }]}><Select loading={loading} options={types.map(t => ({ value: t.id, label: `${t.name} · ${t.payloadCapacityKg} kg · ${t.lengthCm} × ${t.widthCm} × ${t.heightCm} cm` }))} /></Form.Item>
        <Form.Item name="homeBranchId" label="Chi nhánh quản lý" rules={[{ required: true }]}><Select onChange={() => form.setFieldValue('homeDepotLocationId', undefined)} options={branches.map(b => ({ value: b.id, label: b.name }))} /></Form.Item>
        <Form.Item name="homeDepotLocationId" label="Điểm xuất phát mặc định (không phải vị trí thực tế)"><Select allowClear options={locations.filter(l => l.type === 'CENTRAL_WAREHOUSE' && l.managingBranchId === branch).map(l => ({ value: l.id, label: l.name }))} /></Form.Item>
        <Alert type="info" message="Thiếu điểm xuất phát hoặc dữ liệu cửa/vật cản sẽ được báo khi tra cứu; hệ thống không tự điền số đo." />
      </> : <>
        <Alert type="info" message="Employee là nguồn tên, điện thoại, định danh và chi nhánh. Không tạo tài khoản đăng nhập. Nhân viên cần có đủ hồ sơ trước khi liên kết." />
        <Form.Item name="employeeId" label="Nhân viên chưa có hồ sơ tài xế" rules={[{ required: true }]}><Select showSearch filterOption={false} loading={loading} onSearch={s => { setSearch(s); setEmployeePage(1); }} options={employees.map(e => ({ value: e.id, label: `${e.employeeCode} · ${e.fullName}` }))} /></Form.Item>
        <Space><Button disabled={employeePage === 1} onClick={() => setEmployeePage(n => n - 1)}>Trước</Button><span>Trang {employeePage}</span><Button disabled={employeePage * 25 >= employeeTotal} onClick={() => setEmployeePage(n => n + 1)}>Sau</Button></Space>
        {!linkDriver && <><Form.Item name="licenseNumber" label="Số giấy phép" rules={[{ required: true }, { max: 80 }]}><Input /></Form.Item>
          <Form.Item name="licenseClass" label="Hạng giấy phép (theo hồ sơ)" rules={[{ required: true }, { max: 30 }]}><Input /></Form.Item>
          <Form.Item name="licenseExpiry" label="Ngày hết hạn (hết ngày giờ Việt Nam)" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></>}
      </>}
    </Form>
  </Modal>;
}
