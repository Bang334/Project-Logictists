import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, EnvironmentOutlined } from '@ant-design/icons';
import { apiErrorMessage, zonesApi } from '../../api/client';
import type { CurfewWindowConfig, LoadRestrictionZone } from '../../types';

const { Text } = Typography;

interface LoadRestrictionZonesCardProps {
  branchId: string;
  branchName?: string;
  canManage: boolean;
}

const HANOI_INNER_CITY_PRESET = {
  name: 'Nội thành Hà Nội (Vành đai 3)',
  description: 'Cấm xe tải > 2.5 tấn vào khung giờ cao điểm sáng/chiều',
  maxPayloadKg: 2500,
  curfewWindows: [
    { startTime: '06:00', endTime: '09:00' },
    { startTime: '16:00', endTime: '20:00' },
  ],
  polygon: [
    [
      [105.78, 20.95],
      [105.87, 20.95],
      [105.87, 21.08],
      [105.78, 21.08],
      [105.78, 20.95],
    ],
  ],
};

export const LoadRestrictionZonesCard: React.FC<LoadRestrictionZonesCardProps> = ({
  branchId,
  branchName,
  canManage,
}) => {
  const [zones, setZones] = useState<LoadRestrictionZone[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingZone, setEditingZone] = useState<LoadRestrictionZone | null>(null);
  const [form] = Form.useForm();

  const loadZones = useCallback(async () => {
    if (!branchId || branchId === 'COMPANY') {
      setZones([]);
      return;
    }
    setLoading(true);
    try {
      const res = await zonesApi.list(branchId);
      setZones(res.data || []);
    } catch (error) {
      message.error(apiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void loadZones();
  }, [loadZones]);

  const openCreateModal = () => {
    setEditingZone(null);
    form.setFieldsValue({
      name: '',
      description: '',
      maxPayloadKg: 2500,
      active: true,
      curfewWindows: [
        { startTime: '06:00', endTime: '09:00' },
        { startTime: '16:00', endTime: '20:00' },
      ],
      polygonJson: JSON.stringify(HANOI_INNER_CITY_PRESET.polygon, null, 2),
    });
    setModalOpen(true);
  };

  const openEditModal = (zone: LoadRestrictionZone) => {
    setEditingZone(zone);
    form.setFieldsValue({
      name: zone.name,
      description: zone.description || '',
      maxPayloadKg: zone.maxPayloadKg,
      active: zone.active,
      curfewWindows: zone.curfewWindows?.length
        ? zone.curfewWindows
        : [{ startTime: '06:00', endTime: '09:00' }],
      polygonJson: JSON.stringify(zone.polygon, null, 2),
    });
    setModalOpen(true);
  };

  const applyHanoiPreset = () => {
    form.setFieldsValue({
      name: HANOI_INNER_CITY_PRESET.name,
      description: HANOI_INNER_CITY_PRESET.description,
      maxPayloadKg: HANOI_INNER_CITY_PRESET.maxPayloadKg,
      active: true,
      curfewWindows: HANOI_INNER_CITY_PRESET.curfewWindows,
      polygonJson: JSON.stringify(HANOI_INNER_CITY_PRESET.polygon, null, 2),
    });
  };

  const handleToggleActive = async (zone: LoadRestrictionZone, active: boolean) => {
    try {
      await zonesApi.update(zone.id, { active });
      setZones((prev) => prev.map((z) => (z.id === zone.id ? { ...z, active } : z)));
      message.success(active ? `Đã bật vùng "${zone.name}"` : `Đã tạm tắt vùng "${zone.name}"`);
    } catch (error) {
      message.error(apiErrorMessage(error));
    }
  };

  const handleDelete = async (zone: LoadRestrictionZone) => {
    try {
      await zonesApi.remove(zone.id);
      setZones((prev) => prev.filter((z) => z.id !== zone.id));
      message.success(`Đã xóa vùng "${zone.name}"`);
    } catch (error) {
      message.error(apiErrorMessage(error));
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      let parsedPolygon: number[][][];
      try {
        parsedPolygon = JSON.parse(values.polygonJson);
        if (!Array.isArray(parsedPolygon) || !Array.isArray(parsedPolygon[0]) || parsedPolygon[0].length < 4) {
          throw new Error('GeoJSON Polygon phải là mảng [[[lng, lat], ...]] với ít nhất 4 điểm');
        }
      } catch (err) {
        message.error(err instanceof Error ? err.message : 'Tọa độ Polygon không hợp lệ');
        return;
      }

      const payload = {
        name: String(values.name).trim(),
        description: values.description ? String(values.description).trim() : undefined,
        active: Boolean(values.active),
        maxPayloadKg: Number(values.maxPayloadKg),
        polygon: parsedPolygon,
        curfewWindows: (values.curfewWindows || []) as CurfewWindowConfig[],
      };

      setSaving(true);
      if (editingZone) {
        await zonesApi.update(editingZone.id, payload);
        message.success('Đã cập nhật vùng cấm tải');
      } else {
        await zonesApi.create({ branchId, ...payload });
        message.success('Đã tạo vùng cấm tải mới');
      }
      setModalOpen(false);
      await loadZones();
    } catch (error) {
      if (error && typeof error === 'object' && 'errorFields' in error) return;
      message.error(apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      size="small"
      style={{ marginTop: 16 }}
      title={
        <Space>
          <EnvironmentOutlined style={{ color: '#ef4444' }} />
          <span>Vùng cấm tải theo giờ ({branchName || 'Chi nhánh'})</span>
        </Space>
      }
      extra={
        canManage && (
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateModal}>
            Thêm vùng cấm tải
          </Button>
        )
      }
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        Xe có tải trọng cho phép lớn hơn ngưỡng sẽ không được phép lấy/giao hàng bên trong đa giác trong các khung giờ cấm (múi giờ địa phương).
      </Text>

      <Table<LoadRestrictionZone>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={zones}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Chưa cấu hình vùng cấm tải cho chi nhánh này"
            />
          ),
        }}
        columns={[
          {
            title: 'Tên vùng',
            dataIndex: 'name',
            render: (name: string, record) => (
              <div>
                <Text strong>{name}</Text>
                {record.description && (
                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {record.description}
                    </Text>
                  </div>
                )}
              </div>
            ),
          },
          {
            title: 'Ngưỡng xe nặng',
            dataIndex: 'maxPayloadKg',
            width: 150,
            render: (kg: number) => <Tag color="orange">&gt; {kg.toLocaleString('vi-VN')} kg</Tag>,
          },
          {
            title: 'Khung giờ cấm',
            dataIndex: 'curfewWindows',
            render: (windows: CurfewWindowConfig[]) => (
              <Space wrap size={4}>
                {(windows || []).map((w, idx) => (
                  <Tag key={`${w.startTime}-${w.endTime}-${idx}`} color="red">
                    {w.startTime} – {w.endTime}
                  </Tag>
                ))}
              </Space>
            ),
          },
          {
            title: 'Trạng thái',
            dataIndex: 'active',
            width: 100,
            render: (active: boolean, record) => (
              <Switch
                size="small"
                checked={active}
                disabled={!canManage}
                onChange={(checked) => void handleToggleActive(record, checked)}
              />
            ),
          },
          {
            title: 'Thao tác',
            key: 'actions',
            width: 100,
            render: (_, record) =>
              canManage ? (
                <Space size={4}>
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => openEditModal(record)}
                  />
                  <Popconfirm
                    title={`Xóa vùng "${record.name}"?`}
                    onConfirm={() => void handleDelete(record)}
                  >
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ) : null,
          },
        ]}
      />

      <Modal
        title={editingZone ? 'Cập nhật vùng cấm tải' : 'Thêm vùng cấm tải mới'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSave()}
        confirmLoading={saving}
        okText="Lưu vùng cấm tải"
        cancelText="Hủy"
        width={640}
      >
        <div style={{ marginBottom: 12 }}>
          <Button size="small" onClick={applyHanoiPreset}>
            Điền nhanh mẫu Nội thành Hà Nội (2.5T · 06:00–09:00 &amp; 16:00–20:00)
          </Button>
        </div>
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="Tên vùng"
            rules={[{ required: true, message: 'Vui lòng nhập tên vùng' }]}
          >
            <Input placeholder="VD: Nội thành Hà Nội (Vành đai 3)" />
          </Form.Item>
          <Form.Item name="description" label="Mô tả">
            <Input placeholder="Ghi chú phạm vi áp dụng..." />
          </Form.Item>
          <Space style={{ width: '100%' }} size={16}>
            <Form.Item
              name="maxPayloadKg"
              label="Tải trọng tối đa được phép (kg)"
              rules={[{ required: true, message: 'Nhập tải trọng ngưỡng' }]}
            >
              <InputNumber min={100} max={50000} step={100} style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="active" label="Kích hoạt" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>

          <Form.List name="curfewWindows">
            {(fields, { add, remove }) => (
              <div style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 6, fontWeight: 500 }}>Khung giờ cấm (HH:mm)</div>
                {fields.map(({ key, name, ...restField }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                    <Form.Item
                      {...restField}
                      name={[name, 'startTime']}
                      rules={[{ required: true, pattern: /^\d{2}:\d{2}$/, message: 'HH:mm' }]}
                    >
                      <Input placeholder="06:00" style={{ width: 100 }} />
                    </Form.Item>
                    <span>→</span>
                    <Form.Item
                      {...restField}
                      name={[name, 'endTime']}
                      rules={[{ required: true, pattern: /^\d{2}:\d{2}$/, message: 'HH:mm' }]}
                    >
                      <Input placeholder="09:00" style={{ width: 100 }} />
                    </Form.Item>
                    {fields.length > 1 && (
                      <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(name)} />
                    )}
                  </Space>
                ))}
                <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={() => add({ startTime: '16:00', endTime: '20:00' })}>
                  Thêm khung giờ
                </Button>
              </div>
            )}
          </Form.List>

          <Form.Item
            name="polygonJson"
            label="Đa giác GeoJSON [[[lng, lat], ...]]"
            rules={[{ required: true, message: 'Nhập tọa độ đa giác GeoJSON' }]}
          >
            <Input.TextArea rows={5} style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
