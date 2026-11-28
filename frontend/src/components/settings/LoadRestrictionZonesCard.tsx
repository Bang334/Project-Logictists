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

export const HANOI_INNER_CITY_POLYGON: number[][][] = [
  [
    // Vành đai 3 (bờ Nam cầu Thăng Long -> Phạm Văn Đồng -> Phạm Hùng -> Khuất Duy Tiến -> Nguyễn Xiển -> Nghiêm Xuân Yêm -> Cầu vượt Linh Đàm/Pháp Vân -> Đỗ Mười -> Chân cầu Thanh Trì)
    [105.78781, 21.08405],
    [105.78817, 21.08046],
    [105.78578, 21.07566],
    [105.78493, 21.06712],
    [105.78175, 21.0537],
    [105.78055, 21.03823],
    [105.77847, 21.02486],
    [105.77975, 21.02047],
    [105.80342, 20.99172],
    [105.81552, 20.97525],
    [105.81793, 20.9733],
    [105.82621, 20.97049],
    [105.8345, 20.9663],
    [105.85034, 20.96552],
    [105.86568, 20.96363],
    [105.87259, 20.9643],
    [105.87618, 20.96598],
    [105.88147, 20.97245],
    [105.88806, 20.97759],
    [105.89307, 20.98353],
    [105.89476, 20.9834],
    // Đê Hữu Hồng bờ Tây sông Hồng (Đê Nguyễn Khoái -> Trần Khánh Dư -> Trần Quang Khải -> Trần Nhật Duật -> Yên Phụ -> Nghi Tàm -> Âu Cơ -> An Dương Vương -> Cầu Thăng Long)
    [105.89483, 20.98664],
    [105.89205, 20.99245],
    [105.89222, 20.99637],
    [105.8837, 21.00096],
    [105.88198, 21.00125],
    [105.87939, 21.00065],
    [105.87712, 21.00189],
    [105.8718, 21.00322],
    [105.86529, 21.00943],
    [105.86361, 21.01247],
    [105.86049, 21.02467],
    [105.85479, 21.0352],
    [105.83822, 21.05265],
    [105.83292, 21.06093],
    [105.83172, 21.06406],
    [105.82914, 21.065],
    [105.82653, 21.06831],
    [105.82573, 21.07296],
    [105.82072, 21.07756],
    [105.81456, 21.08828],
    [105.81277, 21.08965],
    [105.81074, 21.09007],
    [105.79737, 21.08929],
    [105.78733, 21.09088],
    [105.78781, 21.08405],
  ],
];

export const HANOI_INNER_CITY_PRESET = {
  name: 'Nội thành Hà Nội (Vành đai 3)',
  description:
    'Cấm xe tải > 2.5 tấn giờ cao điểm trong Vành đai 3 – Đê Hữu Hồng bờ Tây sông Hồng',
  maxPayloadKg: 2500,
  curfewWindows: [
    { startTime: '06:00', endTime: '09:00' },
    { startTime: '16:00', endTime: '20:00' },
  ],
  polygon: HANOI_INNER_CITY_POLYGON,
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
