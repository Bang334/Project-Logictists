import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Alert, App, Button, Col, Descriptions, Drawer, Form, Input, Modal, Row, Select, Space, Table, Typography } from 'antd';
import { apiErrorMessage, customersApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Customer, CustomerInput, CustomerOrder } from '../types/customers';

export default function CustomersPage() {
  const { user, can, branchId, setBranchId } = useAuth(), { message } = App.useApp();
  const canReadOrders = can('orders.read');
  const [rows, setRows] = useState<Customer[]>([]), [page, setPage] = useState(1), [pageSize, setPageSize] = useState(25), [total, setTotal] = useState(0);
  const [search, setSearch] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<Customer | null>(null), [detailId, setDetailId] = useState<string>();
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [orders, setOrders] = useState<CustomerOrder[]>([]), [orderTotal, setOrderTotal] = useState(0), [orderPage, setOrderPage] = useState(1), [orderError, setOrderError] = useState('');
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [open, setOpen] = useState(false), [editing, setEditing] = useState<Customer | null>(null), [saving, setSaving] = useState(false), [saveError, setSaveError] = useState(''), [conflict, setConflict] = useState(false);
  const [form] = Form.useForm<CustomerInput & { branchIds: string[] }>();
  const busy = useRef(false), command = useRef<{ payload: string; key: string }>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let live = true; setLoading(true); setError(''); setRows([]); setTotal(0);
    void customersApi.list({ branchId, page, pageSize, search }).then(r => { if (live) { setRows(r.items); setTotal(r.total); } })
      .catch(e => { if (live && !axios.isCancel(e)) setError(apiErrorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [branchId, page, pageSize, search, reload]);
  useEffect(() => {
    let live = true; setDetail(null); setDetailError('');
    if (!detailId) return;
    setDetailLoading(true);
    void customersApi.getOne(detailId, branchId).then(c => { if (live) setDetail(c); }).catch(e => { if (live && !axios.isCancel(e)) setDetailError(apiErrorMessage(e)); })
      .finally(() => { if (live) setDetailLoading(false); });
    return () => { live = false; };
  }, [detailId, branchId, reload]);
  useEffect(() => {
    let live = true; setOrders([]); setOrderTotal(0); setOrderError('');
    if (!detailId || !canReadOrders) { setOrdersLoading(false); return; }
    setOrdersLoading(true);
    void customersApi.orders(detailId, { branchId, page: orderPage, pageSize: 10 }).then(r => { if (live) { setOrders(r.items); setOrderTotal(r.total); } })
      .catch(e => { if (live && !axios.isCancel(e)) setOrderError(apiErrorMessage(e)); })
      .finally(() => { if (live) setOrdersLoading(false); });
    return () => { live = false; };
  }, [detailId, branchId, orderPage, reload, canReadOrders]);
  const begin = async (customer?: Customer) => {
    setSaveError(''); setConflict(false); command.current = undefined;
    try {
      const current = customer ? await customersApi.getOne(customer.id, branchId) : null;
      if (!mounted.current) return;
      if (current && !current.canEdit) { message.error('Bạn không có quyền sửa hồ sơ này'); return; }
      setEditing(current); form.resetFields();
      form.setFieldsValue(current ? { name: current.name, phone: current.phone, email: current.email, contactPerson: current.contactPerson, address: current.address, taxCode: current.taxCode, branchIds: current.branches.map(b => b.id) }
        : { branchIds: branchId ? [branchId] : user?.branches.length === 1 ? [user.branches[0].id] : [] });
      setOpen(true);
    } catch (e) { if (!axios.isCancel(e)) message.error(apiErrorMessage(e)); }
  };
  const save = async (values: CustomerInput & { branchIds: string[] }) => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setSaveError(''); setConflict(false);
    const data: CustomerInput = { name: values.name.trim(), phone: values.phone.trim(), email: values.email?.trim() || null, contactPerson: values.contactPerson?.trim() || null, address: values.address?.trim() || null, taxCode: values.taxCode?.trim() || null };
    if (!editing || editing.canManageScope) data.branchIds = values.branchIds;
    const payload = JSON.stringify({ id: editing?.id, version: editing?.version, ...data });
    if (!command.current || command.current.payload !== payload) command.current = { payload, key: crypto.randomUUID() };
    try {
      const saved = editing ? await customersApi.update(editing.id, { ...data, version: editing.version }, command.current.key)
        : await customersApi.create({ ...data, branchIds: values.branchIds }, command.current.key);
      if (!mounted.current) return;
      setOpen(false); setDetailId(saved.id); setOrderPage(1); setReload(n => n + 1); command.current = undefined;
      message.success('Đã lưu hồ sơ khách hàng trên server');
    } catch (e) {
      if (!mounted.current || axios.isCancel(e)) return;
      setSaveError(apiErrorMessage(e));
      if (axios.isAxiosError(e)) {
        setConflict(e.response?.data?.code === 'CUSTOMER_VERSION_CONFLICT');
        const fields: unknown = e.response?.data?.fieldErrors;
        if (Array.isArray(fields)) form.setFields(fields.flatMap(f => f && typeof f.field === 'string' && ['name','phone','email','contactPerson','address','taxCode','branchIds'].includes(f.field) && typeof f.message === 'string' ? [{ name: f.field, errors: [f.message] }] : []));
      }
    } finally { busy.current = false; if (mounted.current) setSaving(false); }
  };
  const required = [{ required: true, whitespace: true, message: 'Vui lòng nhập thông tin' }];
  if (!can('customers.read')) return <Alert type="warning" message="Bạn không có quyền xem khách hàng" />;
  return <Space direction="vertical" size="middle" style={{ width: '100%', padding: 16, boxSizing: 'border-box' }}>
    <Typography.Title level={2}>Khách hàng vận tải</Typography.Title>
    <Space wrap>
      {can('customers.write') && <Button type="primary" onClick={() => void begin()}>Tạo khách hàng</Button>}
      <Button loading={loading} onClick={() => setReload(n => n + 1)}>Tải lại</Button>
      <Input.Search aria-label="Tìm khách hàng" placeholder="Mã, tên, điện thoại, email" allowClear onSearch={s => { setSearch(s); setPage(1); }} style={{ width: 260, maxWidth: '100%' }} />
      <Select aria-label="Chi nhánh khách hàng" placeholder="Chi nhánh" allowClear value={branchId} style={{ minWidth: 180 }} onChange={id => { setBranchId(id); setPage(1); }} options={user?.branches.map(b => ({ value: b.id, label: b.name }))} />
    </Space>
    {error && <Alert showIcon type="error" message={error} action={<Button onClick={() => setReload(n => n + 1)}>Thử lại</Button>} />}
    <Table<Customer> rowKey="id" dataSource={rows} loading={loading} scroll={{ x: 900 }} locale={{ emptyText: 'Chưa có khách hàng phù hợp' }}
      pagination={{ current: page, pageSize, total, showSizeChanger: true, onChange: (p, size) => { setPage(p); setPageSize(size); } }} columns={[
        { title: 'Mã khách', dataIndex: 'code', width: 230, render: (v: string) => <span style={{ overflowWrap: 'anywhere' }}>{v}</span> },
        { title: 'Tên khách hàng', dataIndex: 'name' }, { title: 'Điện thoại', dataIndex: 'phone' },
        { title: 'Người liên hệ', dataIndex: 'contactPerson' }, { title: 'Chi nhánh được cấp', render: (_, c) => c.branches.map(b => b.name).join(', ') || 'Chưa cấp' },
        { title: 'Thao tác', render: (_, c) => <Space><Button onClick={() => { setDetailId(c.id); setOrderPage(1); }}>Chi tiết</Button>{c.canEdit && <Button onClick={() => void begin(c)}>Sửa</Button>}</Space> },
      ]} />
    <Drawer title="Hồ sơ khách hàng" open={!!detailId} onClose={() => setDetailId(undefined)} width={740}>
      {detailLoading && <Typography.Text>Đang tải hồ sơ...</Typography.Text>}
      {detailError && <Alert type="error" message={detailError} action={<Button onClick={() => setReload(n => n + 1)}>Thử lại</Button>} />}
      {detail && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Descriptions column={1} bordered items={[
          { key: 'code', label: 'Mã khách', children: detail.code }, { key: 'name', label: 'Tên khách hàng', children: detail.name },
          { key: 'phone', label: 'Điện thoại', children: detail.phone }, { key: 'email', label: 'Email', children: detail.email || '—' },
          { key: 'contact', label: 'Người liên hệ', children: detail.contactPerson || '—' }, { key: 'address', label: 'Địa chỉ', children: detail.address || '—' },
          { key: 'tax', label: 'Mã số thuế', children: detail.taxCode || '—' }, { key: 'branches', label: 'Chi nhánh được cấp trong quyền của bạn', children: detail.branches.map(b => b.name).join(', ') || 'Chưa cấp' },
        ]} />
        {detail.canEdit ? <Button onClick={() => void begin(detail)}>Sửa hồ sơ</Button> : <Alert type="info" message="Bạn có quyền xem; hồ sơ này cần người có đủ phạm vi chỉnh sửa" />}
        {can('orders.read') && <><Typography.Title level={4}>Đơn vận tải trong phạm vi của bạn</Typography.Title>
          {orderError && <Alert type="error" message={orderError} action={<Button onClick={() => setReload(n => n + 1)}>Thử lại đơn</Button>} />}
          <Table<CustomerOrder> rowKey="id" dataSource={orders} loading={ordersLoading} scroll={{ x: 500 }} pagination={{ current: orderPage, pageSize: 10, total: orderTotal, showSizeChanger: false, onChange: setOrderPage }} columns={[
            { title: 'Mã đơn', dataIndex: 'orderNumber' }, { title: 'Trạng thái', dataIndex: 'status' }, { title: 'Chi nhánh', render: (_, o) => o.branch.name },
          ]} /></>}
      </Space>}
    </Drawer>
    <Modal title={editing ? 'Sửa khách hàng vận tải' : 'Tạo khách hàng vận tải'} open={open} onCancel={() => { if (!saving) setOpen(false); }} maskClosable={false} footer={null} width={700} style={{ maxWidth: 'calc(100vw - 24px)' }}>
      {saveError && <Alert type="error" showIcon message={saveError} />}
      {conflict && editing && <Button onClick={() => void begin(editing)}>Bỏ bản nhập, tải phiên bản mới vào biểu mẫu</Button>}
      <Form form={form} layout="vertical" onFinish={v => void save(v)} disabled={saving} scrollToFirstError>
        <Form.Item name="name" label="Tên khách hàng" rules={required}><Input autoFocus maxLength={200} /></Form.Item>
        <Row gutter={16}><Col xs={24} sm={12}><Form.Item name="phone" label="Điện thoại" rules={required}><Input maxLength={50} /></Form.Item></Col>
          <Col xs={24} sm={12}><Form.Item name="contactPerson" label="Người liên hệ"><Input maxLength={150} /></Form.Item></Col></Row>
        <Row gutter={16}><Col xs={24} sm={12}><Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Email chưa hợp lệ' }]}><Input maxLength={254} /></Form.Item></Col>
          <Col xs={24} sm={12}><Form.Item name="taxCode" label="Mã số thuế"><Input maxLength={50} /></Form.Item></Col></Row>
        <Form.Item name="address" label="Địa chỉ"><Input.TextArea maxLength={1000} /></Form.Item>
        <Form.Item name="branchIds" label="Chi nhánh được phục vụ" rules={[{ required: true, type: 'array', min: 1, message: 'Chọn ít nhất một chi nhánh' }]}>
          <Select mode="multiple" disabled={saving || (!!editing && !editing.canManageScope)} options={user?.branches.map(b => ({ value: b.id, label: b.name }))} />
        </Form.Item>
        <Typography.Paragraph type="secondary">Thay đổi hồ sơ không sửa địa chỉ hoặc người liên hệ đã lưu trên đơn cũ.</Typography.Paragraph>
        <Space><Button type="primary" htmlType="submit" loading={saving}>Lưu khách hàng</Button><Button disabled={saving} onClick={() => setOpen(false)}>Đóng</Button></Space>
      </Form>
    </Modal>
  </Space>;
}
