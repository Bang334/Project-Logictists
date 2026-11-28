import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  BankOutlined,
  EditOutlined,
  EnvironmentOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { apiErrorMessage, locationsApi } from '../api/client';
import { Branch, WarehouseCustodyPackage, WarehouseSummary } from '../types';
import { MapLocationPickerModal } from './MapLocationPickerModal';

const { Text } = Typography;

interface WarehousesTabProps {
  branches: Branch[];
  selectedBranchId: string;
  canManage: boolean;
}

export const WarehousesTab: React.FC<WarehousesTabProps> = ({
  branches,
  selectedBranchId,
  canManage,
}) => {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] =
    useState<WarehouseSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [form] = Form.useForm<{
    code: string;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
    managingBranchId: string;
    active: boolean;
  }>();

  const fetchWarehouses = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await locationsApi.getWarehouses(
        selectedBranchId !== 'ALL' ? selectedBranchId : undefined,
      );
      setWarehouses(res.data);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [selectedBranchId]);

  useEffect(() => {
    void fetchWarehouses();
  }, [fetchWarehouses]);

  const openCreateModal = () => {
    setEditingWarehouse(null);
    form.resetFields();
    form.setFieldsValue({
      managingBranchId:
        selectedBranchId !== 'ALL'
          ? selectedBranchId
          : branches[0]?.id,
      active: true,
    });
    setModalOpen(true);
  };

  const openEditModal = (warehouse: WarehouseSummary) => {
    setEditingWarehouse(warehouse);
    form.resetFields();
    form.setFieldsValue({
      code: warehouse.code,
      name: warehouse.name,
      address: warehouse.address,
      latitude: warehouse.latitude,
      longitude: warehouse.longitude,
      managingBranchId: warehouse.managingBranchId ?? branches[0]?.id,
      active: warehouse.active,
    });
    setModalOpen(true);
  };

  const handleSave = async (values: {
    code: string;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
    managingBranchId: string;
    active: boolean;
  }) => {
    try {
      setSubmitting(true);
      if (editingWarehouse) {
        await locationsApi.updateWarehouse(editingWarehouse.id, {
          name: values.name,
          address: values.address,
          latitude: values.latitude,
          longitude: values.longitude,
          managingBranchId: values.managingBranchId,
          active: values.active,
        });
        message.success(`Đã cập nhật kho ${values.name}`);
      } else {
        await locationsApi.createWarehouse({
          code: values.code,
          name: values.name,
          address: values.address,
          latitude: values.latitude,
          longitude: values.longitude,
          managingBranchId: values.managingBranchId,
          active: values.active,
        });
        message.success(`Đã tạo kho lưu chuyển ${values.name}`);
      }
      setModalOpen(false);
      await fetchWarehouses();
    } catch (err) {
      message.error(apiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const totalPackagesHeld = warehouses.reduce(
    (sum, wh) => sum + wh.custodyPackageCount,
    0,
  );
  const totalWeightHeldKg = warehouses.reduce(
    (sum, wh) => sum + wh.custodyTotalWeightKg,
    0,
  );

  return (
    <div>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Kho Lưu Chuyển Chi Nhánh"
              value={warehouses.length}
              prefix={<BankOutlined style={{ color: '#0284c7' }} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Kho Đang Hoạt Động"
              value={warehouses.filter((w) => w.active).length}
              valueStyle={{ color: '#059669' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Kiện Lưu Kho Chờ Giao Lại"
              value={totalPackagesHeld}
              prefix={<InboxOutlined style={{ color: '#d97706' }} />}
              valueStyle={{
                color: totalPackagesHeld > 0 ? '#b45309' : '#1e293b',
              }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Tổng Trọng Lượng Lưu Kho"
              value={totalWeightHeldKg}
              precision={2}
              suffix="kg"
            />
          </Card>
        </Col>
      </Row>

      <Row justify="space-between" align="middle" style={{ marginBottom: 12 }}>
        <Col>
          <Text type="secondary">
            Kho lưu chuyển (Hub) dùng để hạ & lưu tạm hàng hoàn khi khách bận đột xuất hoặc bị chắn đường dỡ 3D; tối ưu ngày tiếp theo sẽ nhận hàng từ kho này.
          </Text>
        </Col>
        <Col>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => void fetchWarehouses()}
              loading={loading}
            >
              Tải lại kho
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!canManage}
              onClick={openCreateModal}
            >
              Thêm kho lưu chuyển
            </Button>
          </Space>
        </Col>
      </Row>

      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 12 }}
          action={<Button onClick={() => void fetchWarehouses()}>Thử lại</Button>}
        />
      )}

      <Table<WarehouseSummary>
        rowKey="id"
        loading={loading}
        dataSource={warehouses}
        locale={{
          emptyText: 'Chưa có kho lưu chuyển (CENTRAL_WAREHOUSE) trong chi nhánh này',
        }}
        pagination={{ pageSize: 8 }}
        expandable={{
          rowExpandable: (wh) => wh.custodyPackages.length > 0,
          expandedRowRender: (wh) => (
            <Table<WarehouseCustodyPackage>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={wh.custodyPackages}
              columns={[
                {
                  title: 'Mã kiện',
                  dataIndex: 'packageCode',
                  render: (val: string, pkg) => (
                    <Space direction="vertical" size={0}>
                      <Tag color="cyan">{val}</Tag>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {pkg.description}
                      </Text>
                    </Space>
                  ),
                },
                {
                  title: 'Đơn hàng',
                  dataIndex: 'orderNumber',
                  render: (val: string, pkg) => (
                    <Space direction="vertical" size={0}>
                      <Text strong>{val}</Text>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {pkg.customer?.name ?? 'Khách lẻ'}
                      </Text>
                    </Space>
                  ),
                },
                {
                  title: 'Quy cách & Trọng lượng',
                  render: (_, pkg) => (
                    <span>
                      {(pkg.lengthMm / 10).toFixed(0)}×{(pkg.widthMm / 10).toFixed(0)}×
                      {(pkg.heightMm / 10).toFixed(0)} cm · <strong>{pkg.weightKg} kg</strong>
                    </span>
                  ),
                },
                {
                  title: 'Lần thử giao',
                  dataIndex: 'deliveryAttemptCount',
                  render: (val: number) => (
                    <Tag color={val >= 2 ? 'volcano' : 'orange'}>Lần {val}</Tag>
                  ),
                },
                {
                  title: 'Giao lại đến địa chỉ',
                  render: (_, pkg) =>
                    pkg.deliveryStop?.address ?? 'Chưa có địa chỉ giao',
                },
                {
                  title: 'Thời điểm về kho',
                  dataIndex: 'returnedToHubAt',
                  render: (val: string | null) =>
                    val ? new Date(val).toLocaleString('vi-VN') : '—',
                },
              ]}
            />
          ),
        }}
        columns={[
          {
            title: 'Mã Kho',
            dataIndex: 'code',
            width: 140,
            render: (val: string) => <Tag color="geekblue">{val}</Tag>,
          },
          {
            title: 'Tên Kho & Địa Chỉ',
            render: (_, wh) => (
              <div>
                <Text strong>{wh.name}</Text>
                <div style={{ fontSize: 12, color: '#475569' }}>{wh.address}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  <EnvironmentOutlined /> {wh.latitude.toFixed(5)},{' '}
                  {wh.longitude.toFixed(5)}
                </div>
              </div>
            ),
          },
          {
            title: 'Chi Nhánh Quản Lý',
            render: (_, wh) =>
              wh.managingBranch ? (
                <Tag color="blue">
                  {wh.managingBranch.name} ({wh.managingBranch.code})
                </Tag>
              ) : (
                '—'
              ),
          },
          {
            title: 'Hàng Chờ Giao Lại',
            width: 190,
            render: (_, wh) =>
              wh.custodyPackageCount > 0 ? (
                <Tag color="gold">
                  {wh.custodyPackageCount} kiện · {wh.custodyTotalWeightKg} kg
                </Tag>
              ) : (
                <Text type="secondary">Trống (0 kiện)</Text>
              ),
          },
          {
            title: 'Trạng Thái',
            dataIndex: 'active',
            width: 130,
            render: (active: boolean) => (
              <Tag color={active ? 'success' : 'default'}>
                {active ? 'Hoạt động' : 'Tạm ngừng'}
              </Tag>
            ),
          },
          {
            title: 'Thao Tác',
            width: 110,
            render: (_, wh) => (
              <Button
                size="small"
                icon={<EditOutlined />}
                disabled={!canManage}
                onClick={() => openEditModal(wh)}
              >
                Sửa
              </Button>
            ),
          },
        ]}
      />

      <Modal
        open={modalOpen}
        title={
          editingWarehouse
            ? `Cập nhật kho ${editingWarehouse.code}`
            : 'Thêm kho lưu chuyển chi nhánh'
        }
        onCancel={() => !submitting && setModalOpen(false)}
        footer={null}
        maskClosable={false}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => void handleSave(v)}
          disabled={submitting}
        >
          <Form.Item
            name="managingBranchId"
            label="Chi nhánh quản lý"
            rules={[{ required: true, message: 'Chọn chi nhánh' }]}
          >
            <Select
              options={branches.map((b) => ({
                value: b.id,
                label: `${b.name} (${b.code})`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="code"
            label="Mã kho"
            rules={[{ required: true, message: 'Nhập mã kho' }]}
          >
            <Input
              disabled={Boolean(editingWarehouse)}
              placeholder="Ví dụ: WH-DAD-02"
            />
          </Form.Item>
          <Form.Item
            name="name"
            label="Tên kho"
            rules={[{ required: true, message: 'Nhập tên kho' }]}
          >
            <Input placeholder="Ví dụ: Kho Lưu Chuyển Đà Nẵng 02" />
          </Form.Item>
          <Form.Item
            name="address"
            label="Địa chỉ"
            rules={[{ required: true, message: 'Nhập địa chỉ' }]}
          >
            <Input />
          </Form.Item>
          <Button
            icon={<EnvironmentOutlined />}
            onClick={() => setMapOpen(true)}
            style={{ marginBottom: 12 }}
          >
            Chọn tọa độ kho trên Mapbox
          </Button>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="latitude"
                label="Vĩ độ"
                rules={[{ required: true, message: 'Nhập vĩ độ' }]}
              >
                <InputNumber min={-90} max={90} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="longitude"
                label="Kinh độ"
                rules={[{ required: true, message: 'Nhập kinh độ' }]}
              >
                <InputNumber min={-180} max={180} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="active" label="Đang hoạt động" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={submitting}>
              {editingWarehouse ? 'Lưu cập nhật' : 'Tạo kho'}
            </Button>
            <Button onClick={() => setModalOpen(false)} disabled={submitting}>
              Hủy
            </Button>
          </Space>
        </Form>
      </Modal>

      <MapLocationPickerModal
        open={mapOpen}
        manualAddress
        onCancel={() => setMapOpen(false)}
        initialLocation={{
          address: form.getFieldValue('address') ?? '',
          latitude: form.getFieldValue('latitude') ?? 16.0544,
          longitude: form.getFieldValue('longitude') ?? 108.2022,
        }}
        onSelectLocation={(loc) => {
          form.setFieldsValue({
            address: loc.address,
            latitude: loc.latitude,
            longitude: loc.longitude,
          });
          setMapOpen(false);
        }}
      />
    </div>
  );
};
