import React, { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography } from 'antd';
import type { FormInstance } from 'antd';
import axios from 'axios';
import dayjs, { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { apiErrorMessage, branchesApi, customersApi, ordersApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type { Branch, Order } from '../types';
import type { OrderInput, OrderLineInput, PackageInput, StopInput } from '../types/orders';
import { MapLocationPickerModal } from '../components/MapLocationPickerModal';
import { OrderDetailDrawer } from '../components/OrderDetailDrawer';
dayjs.extend(utc); dayjs.extend(timezone);
const TZ = 'Asia/Ho_Chi_Minh';
interface FormStop extends Omit<StopInput, 'windowStart' | 'windowEnd'> { windowStart?: Dayjs | null; windowEnd?: Dayjs | null }
interface FormValues extends Omit<OrderInput, 'stops'> { stops: FormStop[] }
const blankPackage = () => ({ lengthMm: undefined, widthMm: undefined, heightMm: undefined, weightG: undefined });
const required = [{ required: true, message: 'Vui lòng nhập trường này' }];
const dateValue = (value?: string | null) => value ? dayjs(dayjs(value).tz(TZ).format('YYYY-MM-DDTHH:mm:ss')) : null;
const isoValue = (value?: Dayjs | null) => value ? dayjs.tz(value.format('YYYY-MM-DDTHH:mm:ss'), TZ).toISOString() : null;
function showFieldErrors(error: unknown, form: FormInstance<FormValues>) {
  if (!axios.isAxiosError(error)) return;
  const entries: unknown = error.response?.data?.fieldErrors;
  if (!Array.isArray(entries)) return;
  const fields = entries.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('field' in entry) || !('message' in entry) || typeof entry.field !== 'string' || typeof entry.message !== 'string') return [];
    if (!/^(branchId|customerId|notes|items|stops)(\.[a-zA-Z0-9]+)*$/.test(entry.field)) return [];
    // API paths are runtime strings; Ant Design encodes known form paths as a tuple union.
    type FieldName = Parameters<FormInstance<FormValues>['setFields']>[0][number]['name'];
    const name = entry.field.split('.').map(p => /^\d+$/.test(p) ? Number(p) : p) as FieldName;
    return [{ name, errors: [entry.message] }];
  });
  form.setFields(fields);
  if (fields[0]?.name) form.scrollToField(fields[0].name, { block: 'center' });
}
const PackageFields: React.FC<{ index: number; form: FormInstance<FormValues> }> = ({ index, form }) => {
  const [count, setCount] = useState(1);
  return <Form.List name={[index, 'packages']} rules={[{ validator: async (_, value: unknown[]) => { if (!value?.length || value.length > 500) throw new Error('Mỗi dòng cần từ 1 đến 500 kiện'); } }]}>
    {(fields, { add, remove }, { errors }) => <>
      {fields.map((field, j) => <Card size="small" key={field.key} style={{ marginBottom: 8 }} title={`Kiện ${j + 1}`} extra={<Button danger size="small" onClick={() => remove(field.name)}>Xóa kiện {j + 1}</Button>}>
        <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
        <Row gutter={12}>
          {(['lengthMm', 'widthMm', 'heightMm'] as const).map((key, k) => <Col xs={24} sm={6} key={key}>
            <Form.Item name={[field.name, key]} label={['Dài mỗi kiện (mm)', 'Rộng mỗi kiện (mm)', 'Cao mỗi kiện (mm)'][k]} rules={required}>
              <InputNumber min={1} max={2147483647} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>)}
          <Col xs={24} sm={6}><Form.Item name={[field.name, 'weightG']} label="Khối lượng mỗi kiện (g)" rules={[...required, { pattern: /^[1-9][0-9]*$/, message: 'Nhập số gram nguyên dương' }]}><InputNumber<string> stringMode min="1" max="9223372036854775807" precision={0} style={{ width: '100%' }} /></Form.Item></Col>
        </Row>
        {form.getFieldValue(['items', index, 'packages', field.name, 'id']) && <Typography.Text type="secondary">ID: {String(form.getFieldValue(['items', index, 'packages', field.name, 'id']))}</Typography.Text>}
      </Card>)}
      <Form.ErrorList errors={errors} />
      <Space wrap>
        <Button onClick={() => add(blankPackage())}>Thêm kiện</Button>
        <InputNumber aria-label={`Số kiện nhập nhanh dòng ${index + 1}`} min={1} max={500} precision={0} value={count} onChange={n => setCount(n ?? 1)} />
        <Button onClick={() => {
          const packages: PackageInput[] = form.getFieldValue(['items', index, 'packages']) ?? [];
          const first = packages[0];
          if (!first || !first.lengthMm || !first.widthMm || !first.heightMm || !first.weightG || packages.length + count > 500) {
            form.setFields([{ name: ['items', index, 'packages'], errors: ['Nhập đủ số đo kiện đầu; tổng số kiện không vượt 500'] }]); return;
          }
          for (let n = 0; n < count; n++) add({ lengthMm: first.lengthMm, widthMm: first.widthMm, heightMm: first.heightMm, weightG: first.weightG });
        }}>Thêm N kiện theo số đo kiện đầu</Button>
      </Space>
    </>}
  </Form.List>;
};
const OrdersPage: React.FC = () => {
  const { message } = App.useApp();
  const { can, branchId, setBranchId } = useAuth();
  const [rows, setRows] = useState<Order[]>([]), [total, setTotal] = useState(0);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState(''), [status, setStatus] = useState<string>();
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [saveError, setSaveError] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]), [customers, setCustomers] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [open, setOpen] = useState(false), [editing, setEditing] = useState<Order | null>(null), [detail, setDetail] = useState<Order | null>(null);
  const [mapStop, setMapStop] = useState<number | null>(null);
  const [form] = Form.useForm<FormValues>();
  const formBranch = Form.useWatch('branchId', form);
  const [customersLoading, setCustomersLoading] = useState(false);
  const busy = useRef(false), request = useRef(0);
  const command = useRef<{ payload: string; key: string }>();
  const confirmCommand = useRef<{ id: string; version: number; key: string }>();
  const fetchRows = async () => {
    const seq = ++request.current; setLoading(true); setError('');
    try {
      const data = await ordersApi.list({ branchId, page, pageSize, status, search: search || undefined });
      if (seq === request.current) { setRows(data.items); setTotal(data.total); }
    } catch (e) { if (seq === request.current && !axios.isCancel(e)) { setRows([]); setError(apiErrorMessage(e)); } }
    finally { if (seq === request.current) setLoading(false); }
  };
  useEffect(() => { void fetchRows(); return () => { request.current++; }; }, [branchId, page, pageSize, status, search]);
  useEffect(() => {
    let live = true;
    void branchesApi.getAll().then(b => { if (live) setBranches(b.data); }).catch(e => { if (live && !axios.isCancel(e)) setError(apiErrorMessage(e)); });
    return () => { live = false; };
  }, [branchId]);
  useEffect(() => {
    if (!open || !formBranch) { setCustomers([]); return; }
    let live = true; setCustomersLoading(true); setCustomers([]);
    void customersApi.getAll(formBranch).then(c => { if (live) setCustomers(c.data); })
      .catch(e => { if (live && !axios.isCancel(e)) setSaveError(apiErrorMessage(e)); })
      .finally(() => { if (live) setCustomersLoading(false); });
    return () => { live = false; };
  }, [open, formBranch]);
  const beginCreate = () => {
    setEditing(null); setSaveError(''); command.current = undefined; form.resetFields();
    form.setFieldsValue({ branchId: branchId ?? (branches.length === 1 ? branches[0].id : undefined), stops: [{ type: 'PICKUP', serviceDurationMinutes: 20 }, { type: 'DELIVERY', serviceDurationMinutes: 20 }], items: [{ description: '', packageType: 'CARTON', packages: [blankPackage()] }] });
    setOpen(true);
  };
  const beginEdit = async (order: Order) => {
    try {
      const current = await ordersApi.getOne(order.id); setEditing(current); setDetail(null); setSaveError(''); command.current = undefined; form.resetFields();
      form.setFieldsValue({ branchId: current.branchId, customerId: current.customerId, notes: current.notes,
        stops: current.stops.map(s => ({ ...s, windowStart: dateValue(s.windowStart), windowEnd: dateValue(s.windowEnd) })),
        items: current.items.map(i => ({ id: i.id, description: i.description, packageType: i.packageType, sku: i.sku, packages: i.packages.length ? i.packages.map(p => ({ id: p.id, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm, weightG: p.weightG })) : [blankPackage()] })),
      }); setOpen(true);
    } catch (e) { message.error(apiErrorMessage(e)); }
  };
  const save = async (values: FormValues) => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setSaveError('');
    const input: OrderInput = {
      branchId: values.branchId, customerId: values.customerId, notes: values.notes,
      stops: values.stops.map(s => ({ id: s.id, type: s.type, address: s.address, latitude: s.latitude, longitude: s.longitude, contactName: s.contactName, contactPhone: s.contactPhone, serviceDurationMinutes: s.serviceDurationMinutes, windowStart: isoValue(s.windowStart), windowEnd: isoValue(s.windowEnd) })),
      items: values.items.map(i => ({ id: i.id, sku: i.sku, description: i.description, packageType: i.packageType, packages: i.packages.map(p => ({ id: p.id, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm, weightG: String(p.weightG) })) })),
    };
    const payload = JSON.stringify({ id: editing?.id, version: editing?.version, ...input });
    if (!command.current || command.current.payload !== payload) command.current = { payload, key: crypto.randomUUID() };
    try {
      const saved = editing ? await ordersApi.update(editing.id, { ...input, version: editing.version }, command.current.key) : await ordersApi.create(input, command.current.key);
      setOpen(false); setDetail(saved); command.current = undefined; message.success('Đã lưu đơn trên server'); void fetchRows();
    } catch (e) { setSaveError(apiErrorMessage(e)); showFieldErrors(e, form); }
    finally { busy.current = false; setSaving(false); }
  };
  const confirm = async (order: Order) => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError('');
    if (confirmCommand.current?.id !== order.id || confirmCommand.current.version !== order.version) confirmCommand.current = { id: order.id, version: order.version, key: crypto.randomUUID() };
    try {
      const saved = await ordersApi.confirm(order.id, order.version, confirmCommand.current.key);
      setDetail(saved); confirmCommand.current = undefined; message.success('Đã xác nhận đơn để điều phối'); void fetchRows();
    } catch (e) { setError(apiErrorMessage(e)); message.error(apiErrorMessage(e)); }
    finally { busy.current = false; setSaving(false); }
  };
  const canEdit = (o: Order) => can('orders.write') && ['DRAFT', 'CONFIRMED'].includes(o.status);
  if (!can('orders.read')) return <Alert type="warning" showIcon message="Bạn không có quyền xem đơn hàng" />;
  return <Space direction="vertical" size="middle" style={{ width: '100%', padding: 16, boxSizing: 'border-box' }}>
    <Typography.Title level={2}>Quản lý đơn hàng</Typography.Title>
    <Typography.Text>Quản lý từng kiện và khung giờ bắt đầu phục vụ • Asia/Ho_Chi_Minh (UTC+7)</Typography.Text>
    <Space wrap>
      <Button type="primary" disabled={!can('orders.write')} onClick={beginCreate}>Tạo đơn nháp</Button>
      <Button onClick={() => void fetchRows()} loading={loading}>Tải lại</Button>
      <Input.Search placeholder="Tìm mã đơn hoặc khách" aria-label="Tìm đơn" allowClear onSearch={v => { setSearch(v); setPage(1); }} style={{ width: 240 }} />
      <Select aria-label="Lọc chi nhánh" placeholder="Chi nhánh" allowClear value={branchId} onChange={id => { setBranchId(id); setPage(1); }} style={{ minWidth: 180 }} options={branches.map(b => ({ value: b.id, label: b.name }))} />
      <Select aria-label="Lọc trạng thái" placeholder="Trạng thái" allowClear value={status} onChange={v => { setStatus(v); setPage(1); }} style={{ width: 160 }} options={['DRAFT','CONFIRMED','ASSIGNED','IN_TRANSIT','COMPLETED','CANCELLED'].map(value => ({ value, label: value }))} />
    </Space>
    {error && <Alert type="error" showIcon message={error} action={<Button onClick={() => void fetchRows()}>Thử lại</Button>} />}
    <Table<Order> rowKey="id" loading={loading} dataSource={rows} scroll={{ x: 1000 }} locale={{ emptyText: 'Chưa có đơn phù hợp' }} pagination={{ current: page, pageSize, total, showSizeChanger: true, onChange: (p, size) => { setPage(p); setPageSize(size); } }} columns={[
      { title: 'Mã đơn', dataIndex: 'orderNumber', width: 240, render: (v: string) => <Typography.Text style={{ overflowWrap: 'anywhere' }}>{v}</Typography.Text> },
      { title: 'Khách / Chi nhánh', render: (_, o) => <>{o.customer.name}<br />{o.branch?.name}</> },
      { title: 'Trạng thái', render: (_, o) => <><Tag>{o.status}</Tag>{o.packageDataStatus === 'LEGACY_REVIEW' && <Tag color="orange">Cần đối soát kiện</Tag>}</> },
      { title: 'Tổng đã lưu', render: (_, o) => <>{o.totalPackages} kiện<br />{o.totalWeightKg} kg · {o.totalVolumeM3} m³</> },
      { title: 'Thao tác', render: (_, o) => <Space wrap><Button onClick={() => void ordersApi.getOne(o.id).then(setDetail).catch(e => message.error(apiErrorMessage(e)))}>Chi tiết</Button><Button disabled={!canEdit(o)} onClick={() => void beginEdit(o)}>Sửa</Button>{o.status === 'DRAFT' && <Button disabled={!can('orders.write') || o.packageDataStatus !== 'COMPLETE'} loading={saving} onClick={() => void confirm(o)}>Xác nhận</Button>}</Space> },
    ]} />
    <Modal title={editing ? `Sửa đơn ${editing.orderNumber}` : 'Tạo đơn nháp'} open={open} width={1100} style={{ top: 24, maxWidth: 'calc(100vw - 24px)' }} styles={{ body: { maxHeight: 'calc(100dvh - 140px)', overflowY: 'auto' } }} onCancel={() => { if (!saving) setOpen(false); }} maskClosable={false} footer={null}>
      {saveError && <Alert type="error" showIcon message={saveError} style={{ marginBottom: 16 }} />}
      {editing?.packageDataStatus === 'LEGACY_REVIEW' && <Alert type="warning" showIcon message="Đơn cũ cần đối soát: nhập số đo thực tế từng kiện; không tự chia tổng khối lượng" description={editing.items.map(i => `${i.description}: ${i.quantity} kiện, số cũ ${i.weightKg} kg, ${i.lengthCm} × ${i.widthCm} × ${i.heightCm} cm`).join('; ')} />}
      <Form<FormValues> form={form} layout="vertical" onFinish={values => void save(values)} disabled={saving} scrollToFirstError>
        <Row gutter={16}><Col xs={24} sm={12}><Form.Item name="branchId" label="Chi nhánh quản lý" rules={required}><Select disabled={!!editing} onChange={() => form.setFieldValue('customerId', undefined)} options={branches.map(b => ({ value: b.id, label: b.name }))} /></Form.Item></Col>
          <Col xs={24} sm={12}><Form.Item name="customerId" label="Khách hàng" rules={required}><Select loading={customersLoading} disabled={!formBranch || customersLoading} showSearch optionFilterProp="label" options={customers.map(c => ({ value: c.id, label: `${c.code} — ${c.name}` }))} /></Form.Item></Col></Row>
        <Form.List name="stops">{fields => fields.map((field, i) => <Card key={field.key} title={i === 0 ? 'Điểm lấy hàng' : 'Điểm giao hàng'} style={{ marginBottom: 16 }}>
          <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item><Form.Item name={[field.name, 'type']} hidden><Input /></Form.Item>
          <Form.Item name={[field.name, 'address']} label="Địa chỉ" rules={required}><Input /></Form.Item>
          <Button onClick={() => setMapStop(field.name)}>Chọn {i === 0 ? 'điểm lấy' : 'điểm giao'} trên Mapbox</Button>
          <Row gutter={16}><Col xs={12}><Form.Item name={[field.name, 'latitude']} label="Vĩ độ" rules={required}><InputNumber min={-90} max={90} style={{ width: '100%' }} /></Form.Item></Col><Col xs={12}><Form.Item name={[field.name, 'longitude']} label="Kinh độ" rules={required}><InputNumber min={-180} max={180} style={{ width: '100%' }} /></Form.Item></Col></Row>
          <Row gutter={16}><Col xs={24} sm={12}><Form.Item name={[field.name, 'contactName']} label="Người liên hệ" rules={required}><Input /></Form.Item></Col><Col xs={24} sm={12}><Form.Item name={[field.name, 'contactPhone']} label="Điện thoại" rules={required}><Input /></Form.Item></Col></Row>
          <Row gutter={16}><Col xs={24} sm={12}><Form.Item name={[field.name, 'windowStart']} label="Bắt đầu khung giờ (UTC+7)" rules={[{ validator: async (_, value: Dayjs | null) => { const end: Dayjs | undefined = form.getFieldValue(['stops', i, 'windowEnd']); if ((!value && end) || (!value && editing?.status === 'CONFIRMED')) throw new Error('Cần nhập đủ khung giờ'); } }]}><DatePicker showTime format="DD/MM/YYYY HH:mm" style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item name={[field.name, 'windowEnd']} label="Kết thúc khung giờ (UTC+7)" dependencies={[['stops', i, 'windowStart']]} rules={[{ validator: async (_, value: Dayjs | null) => { const start: Dayjs | undefined = form.getFieldValue(['stops', i, 'windowStart']); if (start && (!value || value.isBefore(start))) throw new Error('Kết thúc phải bằng hoặc sau bắt đầu'); } }]}><DatePicker showTime format="DD/MM/YYYY HH:mm" style={{ width: '100%' }} /></Form.Item></Col></Row>
          <Typography.Paragraph type="secondary">Khung giờ áp dụng cho lúc bắt đầu phục vụ. Bắt buộc nhập đủ trước khi xác nhận; có thể qua ngày.</Typography.Paragraph>
          <Form.Item name={[field.name, 'serviceDurationMinutes']} label="Thời gian phục vụ (phút)" rules={required}><InputNumber min={0} precision={0} /></Form.Item>
        </Card>)}</Form.List>
        <Form.List name="items" rules={[{ validator: async (_, value: OrderLineInput[]) => { if (!value?.length) throw new Error('Cần ít nhất một dòng hàng'); } }]}>{(fields, { add, remove }, { errors }) => <>
          {fields.map((field, i) => <Card title={`Dòng hàng ${i + 1}`} key={field.key} style={{ marginBottom: 16 }} extra={<Button danger onClick={() => remove(field.name)}>Xóa dòng {i + 1}</Button>}>
            <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
            <Row gutter={16}><Col xs={24} sm={16}><Form.Item name={[field.name, 'description']} label="Mô tả hàng" rules={required}><Input maxLength={500} /></Form.Item></Col><Col xs={24} sm={8}><Form.Item name={[field.name, 'packageType']} label="Kiểu đóng gói" rules={required}><Select options={['CARTON','PALLET','CRATE','BAG'].map(value => ({ value, label: value }))} /></Form.Item></Col></Row>
            <Form.Item name={[field.name, 'sku']} label="SKU (tùy chọn)"><Input /></Form.Item>
            <PackageFields index={field.name} form={form} />
          </Card>)}
          <Form.ErrorList errors={errors} /><Button onClick={() => add({ description: '', packageType: 'CARTON', packages: [blankPackage()] })}>Thêm dòng hàng</Button>
        </>}</Form.List>
        <Form.Item name="notes" label="Ghi chú" style={{ marginTop: 16 }}><Input.TextArea maxLength={5000} /></Form.Item>
        <Space wrap><Button type="primary" htmlType="submit" loading={saving}>{editing ? 'Lưu thay đổi' : 'Lưu nháp'}</Button><Button disabled={saving} onClick={() => setOpen(false)}>Đóng</Button></Space>
      </Form>
    </Modal>
    <MapLocationPickerModal manualAddress open={mapStop !== null} onCancel={() => setMapStop(null)} initialLocation={mapStop !== null ? form.getFieldValue(['stops', mapStop]) : undefined} onSelectLocation={location => { if (mapStop !== null) for (const key of ['address', 'latitude', 'longitude'] as const) form.setFieldValue(['stops', mapStop, key], location[key]); setMapStop(null); }} />
    <OrderDetailDrawer open={!!detail} order={detail} onClose={() => setDetail(null)} onEdit={detail && canEdit(detail) ? o => void beginEdit(o) : undefined} />
  </Space>;
};
export default OrdersPage;
