import React, { useEffect, useState } from 'react';
import {
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Radio,
  DatePicker,
  Row,
  Col,
  Space,
  Tag,
  App as AntdApp,
} from 'antd';
import {
  UserOutlined,
  EnvironmentOutlined,
  IdcardOutlined,
  DollarOutlined,
  ClockCircleOutlined,
  PhoneOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { driversApi } from '../api/client';
import { Driver, Branch } from '../types';

interface EditDriverModalProps {
  open: boolean;
  driver: Driver | null;
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
      borderLeft: '3px solid #10b981',
      borderRadius: '0 6px 6px 0',
      marginBottom: 14,
      marginTop: 18,
    }}
  >
    <span style={{ color: '#10b981', fontSize: 15, display: 'flex', alignItems: 'center' }}>
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

const DRIVER_STATUSES: StatusOption[] = [
  {
    value: 'AVAILABLE',
    label: 'Sẵn sàng nhận lệnh',
    color: '#10b981',
    activeBg: '#ecfdf5',
    activeBorder: '#10b981',
    activeText: '#065f46',
  },
  {
    value: 'ON_DUTY',
    label: 'Đang chạy ca',
    color: '#3b82f6',
    activeBg: '#eff6ff',
    activeBorder: '#3b82f6',
    activeText: '#1e40af',
  },
  {
    value: 'RESTING',
    label: 'Nghỉ ca / Ăn trưa',
    color: '#f59e0b',
    activeBg: '#fffbeb',
    activeBorder: '#f59e0b',
    activeText: '#92400e',
  },
  {
    value: 'ON_LEAVE',
    label: 'Nghỉ phép',
    color: '#64748b',
    activeBg: '#f1f5f9',
    activeBorder: '#64748b',
    activeText: '#334155',
  },
];

const DriverStatusSelector: React.FC<{
  value?: string;
  onChange?: (val: string) => void;
}> = ({ value, onChange }) => {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
      {DRIVER_STATUSES.map((item) => {
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

export const EditDriverModal: React.FC<EditDriverModalProps> = ({
  open,
  driver,
  branches,
  onCancel,
  onSuccess,
}) => {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && driver) {
      form.setFieldsValue({
        fullName: driver.fullName,
        phone: driver.phone,
        citizenId: driver.citizenId,
        licenseNumber: driver.licenseNumber,
        licenseClass: driver.licenseClass,
        licenseExpiry: driver.licenseExpiry ? dayjs(driver.licenseExpiry) : null,
        homeBranchId: driver.homeBranchId,
        status: driver.status,
        fixedSalaryMonthly: Number(driver.fixedSalaryMonthly) || 12000000,
        tripBasePay: Number(driver.tripBasePay) || 180000,
        perKmPay: Number(driver.perKmPay) || 1200,
      });
    }
  }, [open, driver, form]);

  const handleFinish = async (values: any) => {
    if (!driver) return;
    try {
      setSubmitting(true);
      await driversApi.update(driver.id, {
        fullName: values.fullName,
        phone: values.phone,
        citizenId: values.citizenId,
        licenseNumber: values.licenseNumber,
        licenseClass: values.licenseClass,
        licenseExpiry: values.licenseExpiry ? values.licenseExpiry.toISOString() : undefined,
        homeBranchId: values.homeBranchId,
        status: values.status,
        fixedSalaryMonthly: values.fixedSalaryMonthly,
        tripBasePay: values.tripBasePay,
        perKmPay: values.perKmPay,
      });
      message.success(`Đã cập nhật hồ sơ tài xế [${values.fullName}] thành công!`);
      onSuccess();
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Có lỗi xảy ra khi cập nhật thông tin tài xế');
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
              backgroundColor: '#ecfdf5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#059669',
            }}
          >
            <UserOutlined style={{ fontSize: 18 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>
              Chỉnh Sửa Hồ Sơ & Trạng Thái Tài Xế
            </span>
            {driver && (
              <Tag
                bordered={false}
                color="success"
                style={{
                  margin: 0,
                  padding: '2px 10px',
                  borderRadius: 12,
                  fontWeight: 500,
                  fontSize: 12,
                }}
              >
                {driver.fullName}
              </Tag>
            )}
          </div>
        </div>
      }
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      okText="Lưu Hồ Sơ"
      cancelText="Hủy Bỏ"
      okButtonProps={{
        style: {
          background: '#10b981',
          borderColor: '#10b981',
          boxShadow: '0 2px 4px rgba(16, 185, 129, 0.25)',
        },
      }}
      width={720}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={handleFinish} style={{ marginTop: 16 }}>
        <Row gutter={[16, 0]}>
          <Col span={12}>
            <Form.Item
              name="fullName"
              label={
                <Space size={4}>
                  <UserOutlined style={{ color: '#64748b' }} />
                  <span>Họ và Tên Tài Xế</span>
                </Space>
              }
              rules={[{ required: true, message: 'Vui lòng nhập họ và tên tài xế' }]}
            >
              <Input placeholder="VD: Lê Quang Dũng" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="phone"
              label={
                <Space size={4}>
                  <PhoneOutlined style={{ color: '#64748b' }} />
                  <span>Số Điện Thoại Liên Hệ</span>
                </Space>
              }
              rules={[{ required: true, message: 'Vui lòng nhập số điện thoại' }]}
            >
              <Input placeholder="VD: 0983334455" />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={[16, 0]}>
          <Col span={12}>
            <Form.Item
              name="citizenId"
              label="Số CCCD / CMND"
              rules={[{ required: true, message: 'Vui lòng nhập số CCCD' }]}
            >
              <Input placeholder="VD: 048085034567" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="homeBranchId"
              label={
                <Space size={4}>
                  <EnvironmentOutlined style={{ color: '#10b981' }} />
                  <span>Chi Nhánh Trực Thuộc</span>
                </Space>
              }
              rules={[{ required: true, message: 'Vui lòng chọn chi nhánh trực thuộc' }]}
            >
              <Select placeholder="Chọn chi nhánh phân công">
                {branches.map((b) => (
                  <Select.Option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
        </Row>

        <SectionHeader icon={<IdcardOutlined />} title="Giấy Phép Lái Xe (GPLX)" />

        <Row gutter={[16, 0]}>
          <Col span={8}>
            <Form.Item
              name="licenseClass"
              label="Hạng Bằng Lái"
              rules={[{ required: true, message: 'Chọn hạng bằng' }]}
            >
              <Select placeholder="Chọn hạng bằng" style={{ width: '100%' }}>
                <Select.Option value="B2">Hạng B2 (Xe dưới 3.5T)</Select.Option>
                <Select.Option value="C">Hạng C (Xe tải từ 3.5T trở lên)</Select.Option>
                <Select.Option value="D">Hạng D (Xe khách 10-30 chỗ)</Select.Option>
                <Select.Option value="E">Hạng E (Xe khách trên 30 chỗ)</Select.Option>
                <Select.Option value="FC">Hạng FC (Đầu kéo, Container)</Select.Option>
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="licenseNumber"
              label="Số Giấy Phép Lái Xe"
              rules={[{ required: true, message: 'Nhập số bằng' }]}
            >
              <Input placeholder="VD: FC-48034567" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="licenseExpiry"
              label="Ngày Hết Hạn GPLX"
              rules={[{ required: true, message: 'Chọn ngày hết hạn' }]}
            >
              <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" placeholder="Chọn ngày" />
            </Form.Item>
          </Col>
        </Row>

        <SectionHeader icon={<ClockCircleOutlined />} title="Trạng Thái Phân Công Ca & Làm Việc" />

        <Form.Item
          name="status"
          rules={[{ required: true, message: 'Vui lòng chọn trạng thái làm việc' }]}
          style={{ marginBottom: 14 }}
        >
          <DriverStatusSelector />
        </Form.Item>

        <SectionHeader icon={<DollarOutlined />} title="Chế Độ Lương & Định Mức Thù Lao" />

        <Row gutter={[16, 0]}>
          <Col span={8}>
            <Form.Item name="fixedSalaryMonthly" label="Lương Cứng Cơ Bản">
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={500000}
                addonAfter="VNĐ/tháng"
                formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="tripBasePay" label="Thù Lao Mở Chuyến">
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={10000}
                addonAfter="VNĐ"
                formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="perKmPay" label="Thù Lao Lăn Bánh">
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={100}
                addonAfter="VNĐ/km"
                formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
};
