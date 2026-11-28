import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Checkbox, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Segmented, Space, Table } from 'antd';
import { apiClient, apiErrorMessage } from '../../api/client';

type ListKey = 'work-policies' | 'toll-corridors';
type WorkPolicy = {
  id: string;
  code: string;
  revision: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  approvalReference?: string | null;
  limits: Record<string, number | boolean>;
};
type TollCorridor = {
  id: string;
  fromProvinceCode: string;
  toProvinceCode: string;
  highwayName?: string | null;
  baseTollVnd: number;
  distanceHintKm?: number | null;
  active: boolean;
};
type TransportRecord = WorkPolicy | TollCorridor;

const limitFields = [
  { name: 'maxContinuousDrivingSec', label: 'Lái liên tục tối đa (giây)', min: 1 },
  { name: 'shortRestDurationSec', label: 'Nghỉ giữa ca (giây)', min: 0 },
  { name: 'maxDailyDrivingSec', label: 'Lái tối đa mỗi ngày (giây)', min: 1 },
  { name: 'dailyRestDurationSec', label: 'Nghỉ ngày (giây)', min: 0 },
  { name: 'maxWeeklyDrivingSec', label: 'Lái tối đa mỗi tuần (giây)', min: 1 },
  { name: 'minInterTripRestSec', label: 'Nghỉ giữa hai chuyến (giây)', min: 0 },
  { name: 'overnightAllowanceVnd', label: 'Phụ cấp qua đêm (VNĐ)', min: 0 },
];
const required = [{ required: true, message: 'Vui lòng nhập giá trị' }];
const codeRules = [...required, { pattern: /^[A-Za-z0-9_-]{1,32}$/, message: 'Tối đa 32 ký tự chữ, số, gạch ngang hoặc gạch dưới' }];

function toForm(record: TransportRecord | null, kind: ListKey) {
  if (!record) {
    return kind === 'work-policies'
      ? { revision: 1, limits: { enabled: true, restAllowanceDuringService: true } }
      : { active: true };
  }
  if (!('limits' in record)) return record;
  const limits = Object.fromEntries(Object.entries(record.limits).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value,
  ]));
  return {
    ...record,
    effectiveFrom: record.effectiveFrom.slice(0, 10),
    effectiveTo: record.effectiveTo?.slice(0, 10),
    limits: { enabled: true, restAllowanceDuringService: true, ...limits },
  };
}

export function TransportSettingsCard({ canManage }: { canManage: boolean }) {
  const { message } = App.useApp();
  const [kind, setKind] = useState<ListKey>('work-policies');
  const [records, setRecords] = useState<TransportRecord[]>([]);
  const [editing, setEditing] = useState<TransportRecord | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const endpoint = `/settings/transport/${kind}`;
  const isPolicy = kind === 'work-policies';
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await apiClient.get<TransportRecord[]>(endpoint, { signal });
      if (!signal?.aborted) setRecords(response.data);
    } catch (error) {
      if (!signal?.aborted) message.error(apiErrorMessage(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [endpoint, message]);

  useEffect(() => {
    const controller = new AbortController();
    setRecords([]);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const save = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setSaving(true);
    try {
      if (editing) await apiClient.put(`${endpoint}/${editing.id}`, values);
      else await apiClient.post(endpoint, values);
      setEditing(undefined);
      message.success('Đã lưu cấu hình vận tải');
      await load();
    } catch (error) {
      message.error(apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await apiClient.delete(`${endpoint}/${id}`);
      await load();
    } catch (error) {
      message.error(apiErrorMessage(error));
    }
  };

  return <Card title="Chính sách vận tải liên tỉnh">
    <Space wrap style={{ marginBottom: 12 }}>
      <Segmented<ListKey> value={kind} onChange={setKind} disabled={editing !== undefined || saving || loading} options={[
        { value: 'work-policies', label: 'Giờ lái và nghỉ' },
        { value: 'toll-corridors', label: 'Phí đường liên tỉnh' },
      ]} />
      {canManage && <Button type="primary" onClick={() => setEditing(null)}>Thêm cấu hình</Button>}
    </Space>
    <Table<TransportRecord> rowKey="id" loading={loading} dataSource={records} columns={[
      { title: isPolicy ? 'Mã và phiên bản' : 'Hành lang', render: (_, row) => 'limits' in row
        ? `${row.code} · v${row.revision}` : `${row.fromProvinceCode} → ${row.toProvinceCode}` },
      { title: isPolicy ? 'Hiệu lực' : 'Phí đường', render: (_, row) => 'limits' in row
        ? [row.effectiveFrom, row.effectiveTo].filter(Boolean).map(date => date?.slice(0, 10)).join(' → ')
        : `${row.baseTollVnd.toLocaleString('vi-VN')} VNĐ${row.active ? '' : ' · Ngừng áp dụng'}` },
      ...(canManage ? [{ title: 'Thao tác', render: (_: unknown, row: TransportRecord) => <Space>
        <Button size="small" onClick={() => setEditing(row)}>Sửa</Button>
        <Popconfirm title="Xóa cấu hình này?" onConfirm={() => remove(row.id)}>
          <Button size="small" danger>Xóa</Button>
        </Popconfirm>
      </Space> }] : []),
    ]} />
    {editing !== undefined && <Modal title={isPolicy ? 'Chính sách giờ lái và nghỉ' : 'Biểu phí đường'}
      open onCancel={() => setEditing(undefined)} onOk={() => void save()}
      okText="Lưu" cancelText="Hủy" confirmLoading={saving} width={680}
    >
      <Form form={form} layout="vertical" initialValues={toForm(editing, kind)} preserve={false}>
        {isPolicy ? <>
          <Row gutter={12}>
            <Col span={16}><Form.Item name="code" label="Mã chính sách" rules={codeRules}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="revision" label="Phiên bản" rules={required}><InputNumber min={1} precision={0} /></Form.Item></Col>
            <Col span={12}><Form.Item name="effectiveFrom" label="Có hiệu lực từ" rules={required}><Input type="date" /></Form.Item></Col>
            <Col span={12}><Form.Item name="effectiveTo" label="Có hiệu lực đến hết ngày"
              normalize={(value: string) => value || null}><Input type="date" /></Form.Item></Col>
          </Row>
          <Form.Item name="approvalReference" label="Tham chiếu phê duyệt"><Input maxLength={255} /></Form.Item>
          <Row gutter={12}>
            {limitFields.map(field => <Col xs={24} sm={12} key={field.name}><Form.Item
              name={['limits', field.name]} label={field.label} rules={required}
            ><InputNumber min={field.min} precision={0} style={{ width: '100%' }} /></Form.Item></Col>)}
          </Row>
          <Form.Item name={['limits', 'enabled']} valuePropName="checked"><Checkbox>Áp dụng giới hạn giờ lái</Checkbox></Form.Item>
          <Form.Item name={['limits', 'restAllowanceDuringService']} valuePropName="checked"><Checkbox>Tính thời gian phục vụ vào thời gian nghỉ nếu đủ điều kiện</Checkbox></Form.Item>
        </> : <>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="fromProvinceCode" label="Mã tỉnh đi" rules={codeRules}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="toProvinceCode" label="Mã tỉnh đến" rules={codeRules}><Input /></Form.Item></Col>
          </Row>
          <Form.Item name="highwayName" label="Tên tuyến đường"><Input maxLength={120} /></Form.Item>
          <Form.Item name="baseTollVnd" label="Phí cơ sở (VNĐ)" rules={required}><InputNumber min={0} max={2147483647} precision={0} /></Form.Item>
          <Form.Item name="distanceHintKm" label="Cự ly tham khảo (km)"><InputNumber min={0} max={10000} /></Form.Item>
          <Form.Item name="active" valuePropName="checked"><Checkbox>Áp dụng biểu phí</Checkbox></Form.Item>
        </>}
      </Form>
    </Modal>}
  </Card>;
}
