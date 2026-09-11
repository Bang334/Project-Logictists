import React, { useEffect, useState } from 'react';
import {
  Modal,
  Form,
  Input,
  Button,
  Space,
  Tag,
  Typography,
  AutoComplete,
  App as AntdApp,
  Alert,
} from 'antd';
import {
  ApartmentOutlined,
  CompassOutlined,
  AimOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { branchesApi, mapboxApi } from '../api/client';
import { Branch } from '../types';
import { MapLocationPickerModal } from './MapLocationPickerModal';

const { Text } = Typography;

interface EditBranchModalProps {
  open: boolean;
  branch: Branch | null;
  onCancel: () => void;
  onSuccess: () => void;
}

export const EditBranchModal: React.FC<EditBranchModalProps> = ({
  open,
  branch,
  onCancel,
  onSuccess,
}) => {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  // Tọa độ GPS của chi nhánh
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

  // Mapbox autocomplete
  const [addressOptions, setAddressOptions] = useState<any[]>([]);

  // Modal bản đồ Mapbox
  const [isMapPickerOpen, setIsMapPickerOpen] = useState(false);

  useEffect(() => {
    if (open && branch) {
      form.setFieldsValue({
        name: branch.name,
        code: branch.code,
        phone: branch.phone || '',
        address: branch.address,
      });

      if (branch.latitude && branch.longitude) {
        setCoords({ lat: branch.latitude, lng: branch.longitude });
      } else {
        setCoords(null);
      }
    }
  }, [open, branch, form]);

  const handleSearchAddress = async (query: string) => {
    if (!query || query.length < 3) return;
    const results = await mapboxApi.geocode(query);
    setAddressOptions(
      results.map((r: any) => ({
        value: r.address,
        label: r.address,
        lat: r.latitude,
        lng: r.longitude,
      })),
    );
  };

  const handleSelectSearchResult = (_value: string, option: any) => {
    if (option.lat && option.lng) {
      setCoords({ lat: option.lat, lng: option.lng });
    }
  };

  const handleSelectFromMap = (result: {
    address: string;
    latitude: number;
    longitude: number;
  }) => {
    form.setFieldsValue({ address: result.address });
    setCoords({ lat: result.latitude, lng: result.longitude });
    setIsMapPickerOpen(false);
  };

  const handleSubmit = async (values: any) => {
    if (!branch) return;

    try {
      setLoading(true);

      const matchedOption = addressOptions.find((o) => o.value === values.address);
      const lat = coords?.lat || matchedOption?.lat;
      const lng = coords?.lng || matchedOption?.lng;

      const payload: Partial<Branch> = {
        name: values.name,
        address: values.address,
        phone: values.phone,
        latitude: lat,
        longitude: lng,
      };

      await branchesApi.update(branch.id, payload);
      message.success(`Đã cập nhật địa chỉ và thông tin chi nhánh "${values.name}" thành công!`);
      onSuccess();
      onCancel();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Lỗi khi cập nhật chi nhánh');
    } finally {
      setLoading(false);
    }
  };

  if (!branch) return null;

  return (
    <>
      <Modal
        title={
          <Space>
            <ApartmentOutlined style={{ color: '#1d4ed8', fontSize: 18 }} />
            <span>Chỉnh Sửa Thông Tin & Địa Chỉ Chi Nhánh</span>
            <Tag color="geekblue">{branch.code}</Tag>
          </Space>
        }
        open={open}
        onCancel={onCancel}
        footer={null}
        width={680}
      >
        <Alert
          type="info"
          showIcon
          message="Bạn có thể chỉnh sửa tên, số điện thoại và đặc biệt là địa chỉ kho bãi của chi nhánh bằng cách gõ tên đường hoặc bấm chọn trực tiếp trên bản đồ Mapbox."
          style={{ marginTop: 12, marginBottom: 16 }}
        />

        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Form.Item
              label="Tên Chi Nhánh / Kho Bãi"
              name="name"
              rules={[{ required: true, message: 'Nhập tên chi nhánh' }]}
            >
              <Input placeholder="Ví dụ: Kho Vận Miền Bắc - Chi nhánh Hà Nội" />
            </Form.Item>

            <Form.Item label="Mã Chi Nhánh" name="code">
              <Input disabled style={{ backgroundColor: '#f1f5f9', fontWeight: 600 }} />
            </Form.Item>
          </div>

          <Form.Item label="Số Điện Thoại Liên Hệ" name="phone">
            <Input placeholder="Số điện thoại hotline chi nhánh" />
          </Form.Item>

          <Form.Item
            label="Địa Chỉ Chi Nhánh (Bãi xe & Kho xuất phát)"
            required
            style={{ marginBottom: 8 }}
          >
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="address"
                noStyle
                rules={[{ required: true, message: 'Nhập hoặc chọn địa chỉ chi nhánh' }]}
              >
                <AutoComplete
                  options={addressOptions}
                  onSearch={handleSearchAddress}
                  onSelect={handleSelectSearchResult}
                  placeholder="Nhập tên đường, KCN, quận huyện (ví dụ: KCN Sài Đồng B, Long Biên...)"
                  style={{ width: 'calc(100% - 160px)' }}
                />
              </Form.Item>
              <Button
                type="primary"
                ghost
                icon={<CompassOutlined />}
                onClick={() => setIsMapPickerOpen(true)}
                style={{ width: '160px' }}
              >
                Chọn trên bản đồ
              </Button>
            </Space.Compact>
          </Form.Item>

          {/* Hiển thị tọa độ GPS */}
          <div style={{ marginBottom: 20 }}>
            {coords && coords.lat && coords.lng ? (
              <Tag color="cyan" icon={<AimOutlined />}>
                Tọa độ GPS chi nhánh: {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
              </Tag>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                📍 Chưa có tọa độ GPS (hệ thống sẽ tự động geocode từ địa chỉ qua Mapbox)
              </Text>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={onCancel}>Hủy bỏ</Button>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={loading}
            >
              Lưu Thay Đổi Chi Nhánh
            </Button>
          </div>
        </Form>
      </Modal>

      {/* Modal Mapbox Picker cho Chi Nhánh */}
      <MapLocationPickerModal
        open={isMapPickerOpen}
        title={`Chọn Vị Trí Kho Bãi Chi Nhánh: ${branch.name}`}
        initialLocation={{
          address: form.getFieldValue('address') || branch.address,
          latitude: coords?.lat || branch.latitude,
          longitude: coords?.lng || branch.longitude,
        }}
        onCancel={() => setIsMapPickerOpen(false)}
        onSelectLocation={handleSelectFromMap}
      />
    </>
  );
};
