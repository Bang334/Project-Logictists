import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import axios from 'axios';
import { accountsApi, apiErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Account, AccountList, AccountQuery, canManageAccounts, CreateAccount } from '../types/accounts';

type FormValues = CreateAccount & { confirmPassword: string };

export default function AccountsPage() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const [query, setQuery] = useState<AccountQuery>({ page: 1, pageSize: 20 });
  const [data, setData] = useState<AccountList>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [locking, setLocking] = useState<string>();
  const savingRef = useRef(false);
  const lockingRef = useRef(false);
  const mounted = useRef(true);
  const [form] = Form.useForm<FormValues>();
  const branchOptions = user?.branches.map(b => ({ value: b.id, label: `${b.code} — ${b.name}` })) ?? [];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setLoading(true); setError(undefined); setData(undefined);
    accountsApi.list(query).then(result => { if (current) setData(result); }).catch(e => {
      if (current && !axios.isCancel(e)) setError(apiErrorMessage(e));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [query, revision]);

  const create = async (values: FormValues) => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setFormError(undefined);
    try {
      await accountsApi.create({ username: values.username.trim(), fullName: values.fullName.trim(), password: values.password, roleCode: values.roleCode, branchIds: values.branchIds });
      if (!mounted.current) return;
      setOpen(false); form.resetFields(); setQuery(q => ({ ...q, page: 1 }));
      void message.success('Đã tạo tài khoản');
    } catch (e) {
      if (!mounted.current || axios.isCancel(e)) return;
      setFormError(apiErrorMessage(e));
      if (axios.isAxiosError(e)) {
        const field: unknown = e.response?.data?.field;
        if (field === 'username' || field === 'fullName' || field === 'password' || field === 'roleCode' || field === 'branchIds') form.setFields([{ name: field, errors: [apiErrorMessage(e)] }]);
      }
    } finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  };
  const lock = async (account: Account) => {
    if (lockingRef.current) return;
    lockingRef.current = true; setLocking(account.id); setError(undefined);
    try {
      await accountsApi.lock(account.id);
      if (!mounted.current) return;
      setRevision(r => r + 1); void message.success('Đã khóa tài khoản và thu hồi các phiên');
    } catch (e) { if (mounted.current && !axios.isCancel(e)) setError(apiErrorMessage(e)); }
    finally { lockingRef.current = false; if (mounted.current) setLocking(undefined); }
  };

  return <section style={{ padding: 24 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginBottom: 16 }}>
      <Typography.Title level={2} style={{ margin: 0 }}>Quản lý tài khoản</Typography.Title>
      {canManageAccounts(user, 'users.create') && <Button type="primary" style={{ marginLeft: 'auto' }} onClick={() => { setFormError(undefined); setOpen(true); }}>Tạo tài khoản</Button>}
    </div>
    <Space wrap style={{ marginBottom: 16 }}>
      <Input.Search aria-label="Tìm tài khoản" placeholder="Username hoặc họ tên" allowClear maxLength={100} onSearch={search => setQuery(q => ({ ...q, search: search.trim() || undefined, page: 1 }))} style={{ width: 260 }} />
      <Select aria-label="Lọc trạng thái" placeholder="Tất cả trạng thái" allowClear style={{ width: 190 }} options={[{ value: 'active', label: 'Đang hoạt động' }, { value: 'locked', label: 'Đã khóa' }]} onChange={(status: AccountQuery['status']) => setQuery(q => ({ ...q, status, page: 1 }))} />
      <Select aria-label="Lọc chi nhánh" placeholder="Tất cả chi nhánh" allowClear showSearch optionFilterProp="label" style={{ width: 300 }} options={branchOptions} onChange={(branchId: string | undefined) => setQuery(q => ({ ...q, branchId, page: 1 }))} />
      <Button onClick={() => setRevision(r => r + 1)} loading={loading}>Tải lại</Button>
    </Space>
    {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} action={<Button onClick={() => setRevision(r => r + 1)}>Thử lại</Button>} />}
    <Table<Account> rowKey="id" dataSource={data?.items ?? []} loading={loading} scroll={{ x: 1050 }}
      locale={{ emptyText: error ? 'Chưa tải được danh sách tài khoản' : 'Không có tài khoản phù hợp' }}
      pagination={{ current: query.page, pageSize: query.pageSize, total: data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], onChange: (page, pageSize) => setQuery(q => ({ ...q, page, pageSize })) }}
      columns={[
        { title: 'Username', dataIndex: 'username' },
        { title: 'Họ tên', dataIndex: 'fullName' },
        { title: 'Vai trò', render: (_, a) => [...new Set(a.roleScopes.map(s => s.role.code))].join(', ') || 'Chưa có vai trò hoạt động' },
        { title: 'Chi nhánh', render: (_, a) => a.roleScopes.some(s => s.scopeType === 'COMPANY') ? 'Toàn công ty' : [...new Set(a.roleScopes.flatMap(s => s.branch ? [s.branch.name] : []))].join(', ') || 'Chưa có phạm vi' },
        { title: 'Trạng thái', render: (_, a) => <Tag color={a.active ? 'green' : 'default'}>{a.active ? 'Đang hoạt động' : 'Đã khóa'}</Tag> },
        { title: 'Ngày tạo', render: (_, a) => new Date(a.createdAt).toLocaleString('vi-VN') },
        { title: 'Thao tác', render: (_, a) => a.active && a.id !== user?.id && canManageAccounts(user, 'users.lock') && <Popconfirm title={`Khóa tài khoản ${a.username}?`} description="Mọi phiên đang hoạt động sẽ bị thu hồi." okText="Xác nhận khóa" cancelText="Hủy" onConfirm={() => lock(a)}>
          <Button danger disabled={!!locking} loading={locking === a.id}>Khóa</Button>
        </Popconfirm> },
      ]} />
    <Modal title="Tạo tài khoản DISPATCHER" open={open} destroyOnClose maskClosable={!saving} closable={!saving} onCancel={() => { if (!saving) { setOpen(false); form.resetFields(); } }} footer={null}>
      {formError && <Alert type="error" showIcon message={formError} style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical" onFinish={create} disabled={saving} requiredMark>
        <Form.Item name="username" label="Username" rules={[{ required: true, whitespace: true, message: 'Nhập username' }, { max: 100, message: 'Username tối đa 100 ký tự' }]}><Input autoComplete="off" /></Form.Item>
        <Form.Item name="fullName" label="Họ tên" rules={[{ required: true, whitespace: true, message: 'Nhập họ tên' }, { max: 200, message: 'Họ tên tối đa 200 ký tự' }]}><Input autoComplete="off" /></Form.Item>
        <Form.Item name="password" label="Mật khẩu" rules={[{ required: true, message: 'Nhập mật khẩu' }, { validator: (_, value: unknown) => typeof value === 'string' && new TextEncoder().encode(value).length >= 12 && new TextEncoder().encode(value).length <= 72 ? Promise.resolve() : Promise.reject(new Error('Mật khẩu phải có từ 12 đến 72 byte UTF-8')) }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item name="confirmPassword" label="Xác nhận mật khẩu" dependencies={['password']} rules={[{ required: true, message: 'Xác nhận mật khẩu' }, { validator: (_, value: unknown) => value === form.getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('Mật khẩu xác nhận không khớp')) }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item name="roleCode" label="Vai trò" rules={[{ required: true, message: 'Chọn vai trò' }]}><Select options={[{ value: 'DISPATCHER', label: 'DISPATCHER' }]} placeholder="Chọn vai trò" /></Form.Item>
        <Form.Item name="branchIds" label="Chi nhánh được cấp" rules={[{ required: true, type: 'array', min: 1, message: 'Chọn ít nhất một chi nhánh' }]}><Select mode="multiple" options={branchOptions} optionFilterProp="label" placeholder="Chọn một hoặc nhiều chi nhánh" /></Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>Lưu tài khoản</Button>
      </Form>
    </Modal>
  </section>;
}
