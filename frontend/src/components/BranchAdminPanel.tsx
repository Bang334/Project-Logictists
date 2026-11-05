import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import axios from 'axios';
import { apiErrorMessage, branchesApi } from '../api/client';
import { BranchInput, ManagedBranch } from '../types/branches';
import { EditBranchModal } from './EditBranchModal';

export default function BranchAdminPanel() {
  const [query, setQuery] = useState<{ page: number; search?: string; status?: string }>({ page: 1 });
  const [data, setData] = useState<{ items: ManagedBranch[]; total: number }>({ items: [], total: 0 });
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>(), [formError, setFormError] = useState<string>();
  const [open, setOpen] = useState(false), [edit, setEdit] = useState<ManagedBranch | null>(null);
  const [form] = Form.useForm<BranchInput>();
  const busy = useRef(false), createKey = useRef(crypto.randomUUID());
  const statusKeys = useRef(new Map<string, string>());
  useEffect(() => {
    let current = true; setLoading(true); setError(undefined);
    branchesApi.listAdmin(query).then(value => { if (current) setData(value); }).catch(e => { if (current) { setData({ items: [], total: 0 }); setError(apiErrorMessage(e)); } }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [query, revision]);
  const create = async (values: BranchInput) => {
    if (busy.current) return; busy.current = true; setSaving(true); setFormError(undefined);
    try { await branchesApi.create(values, createKey.current); form.resetFields(); setOpen(false); setRevision(v => v + 1); }
    catch (e) {
      setFormError(apiErrorMessage(e));
      if (axios.isAxiosError(e) && e.response?.data?.field === 'code') form.setFields([{ name: 'code', errors: [apiErrorMessage(e)] }]);
    }
    finally { busy.current = false; setSaving(false); }
  };
  const status = async (branch: ManagedBranch) => {
    if (busy.current) return; busy.current = true; setSaving(true); setError(undefined);
    const identity = `${branch.id}:${branch.updatedAt}:${!branch.active}`;
    const key = statusKeys.current.get(identity) ?? crypto.randomUUID(); statusKeys.current.set(identity, key);
    try { await branchesApi.setActive(branch.id, !branch.active, branch.updatedAt, key); setRevision(v => v + 1); }
    catch (e) {
      const impacts: unknown = axios.isAxiosError(e) ? e.response?.data?.impacts : undefined;
      const labels: Record<string, string> = { drivers: 'tài xế', vehicles: 'xe', accounts: 'tài khoản', customers: 'khách hàng', trips: 'chuyến', orders: 'đơn', reservations: 'giữ lịch' };
      const detail = impacts && typeof impacts === 'object' ? Object.entries(impacts).filter(([, count]) => typeof count === 'number' && count > 0).map(([key, count]) => `${labels[key] ?? key}: ${count}`).join('; ') : '';
      setError([apiErrorMessage(e), detail].filter(Boolean).join(' — '));
    } finally { busy.current = false; setSaving(false); }
  };
  return <>
    <Space wrap style={{ marginBottom: 12 }}>
      <Input.Search aria-label="Tìm chi nhánh" placeholder="Mã hoặc tên chi nhánh" onSearch={search => setQuery(q => ({ ...q, search, page: 1 }))} />
      <Select aria-label="Trạng thái chi nhánh" allowClear placeholder="Tất cả trạng thái" style={{ width: 180 }} options={[{ value: 'active', label: 'Hoạt động' }, { value: 'inactive', label: 'Đã ngừng' }]} onChange={status => setQuery(q => ({ ...q, status, page: 1 }))} />
      <Button type="primary" onClick={() => { createKey.current = crypto.randomUUID(); setFormError(undefined); setOpen(true); }}>Tạo chi nhánh</Button>
      <Button onClick={() => setRevision(v => v + 1)}>Tải lại</Button>
    </Space>
    {error && <Alert type="error" message={error} showIcon />}
    <Table<ManagedBranch> rowKey="id" dataSource={data.items} loading={loading} scroll={{ x: 800 }} pagination={{ current: query.page, pageSize: 20, total: data.total, showSizeChanger: false, onChange: page => setQuery(q => ({ ...q, page })) }} columns={[
      { title: 'Mã', dataIndex: 'code' }, { title: 'Tên', dataIndex: 'name' }, { title: 'Địa chỉ quản lý', dataIndex: 'address' },
      { title: 'Trạng thái', render: (_, b) => <Tag color={b.active ? 'green' : 'default'}>{b.active ? 'Hoạt động' : 'Đã ngừng'}</Tag> },
      { title: 'Thao tác', render: (_, b) => <Space><Button onClick={() => setEdit(b)}>Chi tiết / sửa</Button><Popconfirm title={b.active ? 'Ngừng hoạt động chi nhánh?' : 'Kích hoạt lại chi nhánh?'} description="Không chuyển dữ liệu hoặc tự cấp lại quyền. Chi nhánh còn liên kết hoạt động sẽ bị chặn." onConfirm={() => status(b)} okText="Xác nhận" cancelText="Hủy"><Button disabled={saving} danger={b.active}>{b.active ? 'Ngừng' : 'Kích hoạt lại'}</Button></Popconfirm></Space> },
    ]} />
    <EditBranchModal open={!!edit} branch={edit} onCancel={() => setEdit(null)} onSuccess={() => setRevision(v => v + 1)} />
    <Modal title="Tạo chi nhánh quản lý" open={open} footer={null} closable={!saving} maskClosable={!saving} onCancel={() => { if (!busy.current) { setOpen(false); form.resetFields(); } }}>
      {formError && <Alert type="error" message={formError} />}
      <Form form={form} layout="vertical" disabled={saving} onFinish={create} onValuesChange={() => { createKey.current = crypto.randomUUID(); }}>
        <Form.Item name="code" label="Mã chi nhánh" rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/, message: '2–40 ký tự chữ, số, gạch ngang hoặc gạch dưới' }]}><Input /></Form.Item>
        <Form.Item name="name" label="Tên chi nhánh" rules={[{ required: true, whitespace: true }, { max: 200 }]}><Input /></Form.Item>
        <Form.Item name="address" label="Địa chỉ quản lý" rules={[{ required: true, whitespace: true }, { max: 500 }]}><Input /></Form.Item>
        <Form.Item name="latitude" label="Vĩ độ thực tế" rules={[{ required: true }]}><InputNumber min={-90} max={90} /></Form.Item>
        <Form.Item name="longitude" label="Kinh độ thực tế" rules={[{ required: true }]}><InputNumber min={-180} max={180} /></Form.Item>
        <Form.Item name="phone" label="Điện thoại" rules={[{ max: 40 }]}><Input /></Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>Lưu chi nhánh</Button>
      </Form>
    </Modal>
  </>;
}
