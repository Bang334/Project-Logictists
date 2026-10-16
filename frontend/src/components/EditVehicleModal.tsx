import React, { useEffect, useState } from 'react';
import {
  Modal,
  Form,
  Input,
  Select,
  Row,
  Col,
  Space,
  Tag,
  App as AntdApp,
} from 'antd';
import {
  CarOutlined,
  EnvironmentOutlined,
  DashboardOutlined,
  InboxOutlined,
  TagOutlined,
  HomeOutlined,
} from '@ant-design/icons';
import { vehiclesApi, locationsApi } from '../api/client';
import { Vehicle, VehicleType, Branch, Location } from '../types';

interface EditVehicleModalProps {
  open: boolean;
  vehicle: Vehicle | null;
  branches: Branch[];
  onCancel: () => void;
  onSuccess: () => void;
}

const SectionHeader: React.FC<{ icon: React.ReactNode; title: string }> = ({ icon, title }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 12px',
      background: '#f8fafc',
      borderLeft: '3px solid #2563eb',
      borderRadius: '0 6px 6px 0',
      marginBottom: 14,
      marginTop: 18,
    }}
  >
    <span style={{ color: '#2563eb', fontSize: 15, display: 'flex', alignItems: 'center' }}>
      {icon}
    </span>
    <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
      {title}
    </span>
  </div>
);

interface StatusOption {
  value: string;
  label: string;
  color: string;
  activeBg: string;
  activeBorder: string;
  activeText: string;
}

const VEHICLE_STATUSES: StatusOption[] = [
  {
    value: 'AVAILABLE',
    label: 'Sẵn sàng',
    color: '#10b981',
    activeBg: '#ecfdf5',
    activeBorder: '#10b981',
    activeText: '#065f46',
  },
  {
    value: 'ON_TRIP',
    label: 'Chạy chuyến',
    color: '#3b82f6',
    activeBg: '#eff6ff',
    activeBorder: '#3b82f6',
    activeText: '#1e40af',
  },
  {
    value: 'MAINTENANCE',
    label: 'Bảo dưỡng',
    color: '#f59e0b',
    activeBg: '#fffbeb',
    activeBorder: '#f59e0b',
    activeText: '#92400e',
  },
  {
    value: 'DECOMMISSIONED',
    label: 'Ngừng chạy',
    color: '#ef4444',
    activeBg: '#fef2f2',
    activeBorder: '#ef4444',
    activeText: '#991b1b',
  },
];

const VehicleStatusSelector: React.FC<{
  value?: string;
  onChange?: (val: string) => void;
}> = ({ value, onChange }) => {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
      {VEHICLE_STATUSES.map((item) => {
        const isSelected = value === item.value;
        return (
          <div
            key={item.value}
            onClick={() => onChange?.(item.value)}
            style={{
              cursor: 'pointer',
              borderRadius: 8,
              padding: '10px 4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              background: isSelected ? item.activeBg : '#ffffff',
              border: isSelected ? `2px solid ${item.activeBorder}` : '1px solid #e2e8f0',
              boxShadow: isSelected
                ? `0 2px 6px ${item.activeBorder}25`
                : '0 1px 2px rgba(0,0,0,0.03)',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              userSelect: 'none',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: item.color,
                boxShadow: isSelected ? `0 0 0 3px ${item.color}33` : 'none',
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: 13,
                fontWeight: isSelected ? 600 : 500,
                color: isSelected ? item.activeText : '#475569',
                whiteSpace: 'nowrap',
              }}
            >
              {item.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export const EditVehicleModal: React.FC<EditVehicleModalProps> = ({
  open,
  vehicle,
  branches,
  onCancel,
  onSuccess,
}) => {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [depots, setDepots] = useState<Location[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const watchedBranchId = Form.useWatch('homeBranchId', form);
  const watchedVehicleTypeId = Form.useWatch('vehicleTypeId', form);
  const selectedVehicleType = vehicleTypes.find((type) => type.id === watchedVehicleTypeId);

  useEffect(() => {
    if (open) {
      Promise.all([locationsApi.getAll(), vehiclesApi.getTypes()])
        .then(([locationsResponse, typesResponse]) => {
          setDepots((locationsResponse.data || []).filter(
            (loc) => loc.type === 'CENTRAL_WAREHOUSE',
          ));
          setVehicleTypes(typesResponse.data || []);
        })
        .catch(() => {
          message.error('Không thể tải kho trung tâm hoặc danh mục loại xe');
        });
    }
  }, [open, message]);

  useEffect(() => {
    if (open && vehicle) {
      form.setFieldsValue({
        plateNumber: vehicle.plateNumber,
        model: vehicle.model,
        vehicleTypeId: vehicle.vehicleTypeId,
        homeBranchId: vehicle.homeBranchId,
        homeDepotLocationId: vehicle.homeDepotLocationId || vehicle.homeDepotLocation?.id,
        status: vehicle.status,
      });
    }
  }, [open, vehicle, form]);

  const handleFinish = async (values: any) => {
    if (!vehicle) return;
    try {
      setSubmitting(true);
      await vehiclesApi.update(vehicle.id, {
        plateNumber: values.plateNumber,
        model: values.model,
        vehicleTypeId: values.vehicleTypeId,
        homeBranchId: values.homeBranchId,
        homeDepotLocationId: values.homeDepotLocationId,
        status: values.status,
      });
      message.success(`Đã cập nhật thông tin xe tải [${values.plateNumber}] thành công!`);
      onSuccess();
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Có lỗi xảy ra khi cập nhật xe tải');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              backgroundColor: '#eff6ff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#2563eb',
            }}
          >
            <CarOutlined style={{ fontSize: 18 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>
              Chỉnh Sửa Thông Tin & Trạng Thái Xe Tải
            </span>
            {vehicle && (
              <Tag
                bordered={false}
                color="blue"
                style={{
                  margin: 0,
                  padding: '2px 10px',
                  borderRadius: 12,
                  fontWeight: 600,
                  fontSize: 12,
                }}
              >
                {vehicle.plateNumber}
              </Tag>
            )}
          </div>
        </div>
      }
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      okText="Lưu Thay Đổi"
      cancelText="Hủy Bỏ"
      okButtonProps={{
        style: {
          background: '#2563eb',
          borderColor: '#2563eb',
          boxShadow: '0 2px 4px rgba(37, 99, 235, 0.25)',
        },
      }}
      width={720}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={handleFinish} style={{ marginTop: 16 }}>
        <Row gutter={[16, 0]}>
          <Col span={12}>
            <Form.Item
              name="plateNumber"
              label={
                <Space size={4}>
                  <TagOutlined style={{ color: '#64748b' }} />
                  <span>Biển Số Xe</span>
                </Space>
              }
              rules={[{ required: true, message: 'Vui lòng nhập biển số xe' }]}
            >
              <Input placeholder="VD: 43C-312.45" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="model"
              label="Dòng Xe / Nhãn Hiệu"
              rules={[{ required: true, message: 'Vui lòng nhập dòng xe' }]}
            >
              <Input placeholder="VD: Hino 500 Series FC9J" />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={[16, 0]}>
          <Col span={12}>
            <Form.Item
              name="vehicleTypeId"
              label="Phân Loại Thùng & Tải Trọng"
              rules={[{ required: true, message: 'Vui lòng chọn loại xe' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="Chọn cấu hình loại xe"
                options={vehicleTypes.map((type) => ({
                  value: type.id,
                  label: `${type.name} — ${type.payloadCapacityKg.toLocaleString()} kg / ${type.volumeCapacityM3} m³`,
                }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="homeBranchId"
              label={
                <Space size={4}>
                  <EnvironmentOutlined style={{ color: '#2563eb' }} />
                  <span>Chi Nhánh Trực Thuộc (Home Branch)</span>
                </Space>
              }
              rules={[{ required: true, message: 'Vui lòng chọn chi nhánh trực thuộc' }]}
            >
              <Select
                placeholder="Chọn chi nhánh quản lý xe"
                onChange={() => {
                  form.setFieldValue('homeDepotLocationId', undefined);
                }}
              >
                {branches.map((b) => (
                  <Select.Option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={[16, 0]}>
          <Col span={24}>
            <Form.Item
              name="homeDepotLocationId"
              label={
                <Space size={4}>
                  <HomeOutlined style={{ color: '#059669' }} />
                  <span>Kho Đỗ Xuất Phát (Home Depot - Lập Lịch)</span>
                </Space>
              }
              rules={[{ required: true, message: 'Vui lòng chọn kho đỗ xuất phát của xe' }]}
              extra="Khi lập lịch và tối ưu, xe luôn được coi là xuất phát từ kho này. Tọa độ GPS chỉ dùng cho giám sát hành trình."
            >
              <Select placeholder="Chọn kho trung tâm trực thuộc làm điểm đỗ / xuất phát">
                {depots
                  .filter((d) => !watchedBranchId || d.managingBranchId === watchedBranchId)
                  .map((d) => (
                    <Select.Option key={d.id} value={d.id}>
                      {d.name} ({d.code}) - {d.address}
                    </Select.Option>
                  ))}
              </Select>
            </Form.Item>
          </Col>
        </Row>

        <SectionHeader icon={<DashboardOutlined />} title="Trạng Thái Hoạt Động Của Xe" />

        <Form.Item
          name="status"
          rules={[{ required: true, message: 'Vui lòng chọn trạng thái xe' }]}
          style={{ marginBottom: 14 }}
        >
          <VehicleStatusSelector />
        </Form.Item>

        <SectionHeader icon={<InboxOutlined />} title="Thông Số Theo Loại Xe" />
        {selectedVehicleType && (
          <Space wrap size={[8, 8]}>
            <Tag color="blue">{selectedVehicleType.payloadCapacityKg.toLocaleString()} kg</Tag>
            <Tag color="cyan">{selectedVehicleType.volumeCapacityM3} m³</Tag>
            <Tag>{selectedVehicleType.lengthCm} × {selectedVehicleType.widthCm} × {selectedVehicleType.heightCm} cm</Tag>
            <Tag color="green">{selectedVehicleType.fuelConsumptionLitersPer100Km} L/100km</Tag>
            <Tag color="purple">+{selectedVehicleType.loadFuelSurchargePercentAtFullPayload}% khi đầy tải</Tag>
            <Tag color="orange">{Number(selectedVehicleType.fixedOperatingCostPerTrip).toLocaleString('vi-VN')} VNĐ/chuyến</Tag>
            <Tag color="gold">1 cửa sau</Tag>
          </Space>
        )}
      </Form>
    </Modal>
  );
};
