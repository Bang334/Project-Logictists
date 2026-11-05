import React, { useEffect, useRef, useState } from 'react';
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
  Divider,
  InputNumber,
  Select,
} from 'antd';
import {
  ApartmentOutlined,
  CompassOutlined,
  AimOutlined,
  EnvironmentOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { apiErrorMessage, branchesApi, mapboxApi } from '../api/client';
import { Branch } from '../types';
import { MapLocationPickerModal } from './MapLocationPickerModal';

const { Text } = Typography;
type BranchForm = Pick<Branch, 'name' | 'code' | 'address' | 'phone' | 'deliveryGraceDays' | 'lateDeliveryPenaltyMode'> & { lateDeliveryPenaltyValue: number };
interface AddressOption { value: string; label: string; lat: number; lng: number }

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
  const [form] = Form.useForm<BranchForm>();
  const [loading, setLoading] = useState(false);
  const saving = useRef(false);
  const searchVersion = useRef(0);
  const [error, setError] = useState<string>();
  const [addressError, setAddressError] = useState<string>();

  // Tọa độ GPS của chi nhánh
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

  // Mapbox autocomplete
  const [addressOptions, setAddressOptions] = useState<AddressOption[]>([]);

  // Modal bản đồ Mapbox
  const [isMapPickerOpen, setIsMapPickerOpen] = useState(false);

  useEffect(() => {
    if (open && branch) {
      setError(undefined); setAddressError(undefined); setAddressOptions([]);
      form.setFieldsValue({
        name: branch.name,
        code: branch.code,
        phone: branch.phone || '',
        address: branch.address,
        deliveryGraceDays: branch.deliveryGraceDays ?? 2,
        lateDeliveryPenaltyMode: branch.lateDeliveryPenaltyMode ?? 'NONE',
        lateDeliveryPenaltyValue: Number(branch.lateDeliveryPenaltyValue ?? 0),
      });

      if (branch.latitude != null && branch.longitude != null) {
        setCoords({ lat: branch.latitude, lng: branch.longitude });
      } else {
        setCoords(null);
      }
    }
  }, [open, branch, form]);

  const handleSearchAddress = async (query: string) => {
    const version = ++searchVersion.current;
    setCoords(null); setAddressOptions([]); setAddressError(undefined);
    if (!query || query.length < 3) return;
    try {
      const results: unknown = await mapboxApi.geocode(query);
      if (version !== searchVersion.current) return;
      const options: AddressOption[] = [];
      if (Array.isArray(results)) for (const result of results) {
        if (result && typeof result === 'object' && typeof result.address === 'string' && Number.isFinite(result.latitude) && Number.isFinite(result.longitude)) {
          options.push({ value: result.address, label: result.address, lat: result.latitude, lng: result.longitude });
        }
      }
      setAddressOptions(options);
      if (!options.length) setAddressError('Chưa lấy được gợi ý địa chỉ. Hãy thử lại hoặc chọn trên bản đồ.');
    } catch (e) { if (version === searchVersion.current) setAddressError(apiErrorMessage(e)); }
  };

  const handleSelectSearchResult = (_value: string, option: AddressOption) => {
    ++searchVersion.current; setAddressError(undefined);
    setCoords({ lat: option.lat, lng: option.lng });
  };

  const handleSelectFromMap = (result: {
    address: string;
    latitude: number;
    longitude: number;
  }) => {
    ++searchVersion.current; setAddressError(undefined);
    form.setFieldsValue({ address: result.address });
    setCoords({ lat: result.latitude, lng: result.longitude });
    setIsMapPickerOpen(false);
  };

  const handleSubmit = async (values: BranchForm) => {
    if (!branch || saving.current) return;
    if (!branch.updatedAt) { message.error('Thiếu phiên bản chi nhánh. Hãy tải lại dữ liệu.'); return; }

    try {
      saving.current = true; setLoading(true); setError(undefined);

      const matchedOption = addressOptions.find((o) => o.value === values.address);
      const lat = coords?.lat ?? matchedOption?.lat;
      const lng = coords?.lng ?? matchedOption?.lng;

      const payload = {
        expectedUpdatedAt: branch.updatedAt,
        name: values.name,
        address: values.address,
        phone: values.phone,
        latitude: lat,
        longitude: lng,
        deliveryGraceDays: values.deliveryGraceDays,
        lateDeliveryPenaltyMode: values.lateDeliveryPenaltyMode,
        lateDeliveryPenaltyValue: values.lateDeliveryPenaltyValue,
      };

      await branchesApi.update(branch.id, payload);
      message.success(`Đã cập nhật địa chỉ và thông tin chi nhánh "${values.name}" thành công!`);
      onSuccess();
      onCancel();
    } catch (error: unknown) {
      setError(apiErrorMessage(error));
    } finally {
      saving.current = false; setLoading(false);
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
        onCancel={() => { if (!saving.current) onCancel(); }}
        closable={!loading}
        maskClosable={!loading}
        footer={null}
        width={680}
      >
        <Alert
          type="info"
          showIcon
          message="Chỉnh sửa thông tin và địa chỉ chi nhánh. Thay đổi này không sửa địa điểm đã lưu trên đơn hoặc chuyến cũ."
          style={{ marginTop: 12, marginBottom: 16 }}
        />

        {error && <Alert type="error" showIcon message={error} />}
        <Form form={form} layout="vertical" onFinish={handleSubmit} disabled={loading}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Form.Item
              label="Tên Chi Nhánh"
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
            label="Địa Chỉ Chi Nhánh"
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

          {addressError && <Alert type="warning" message={addressError} />}
          {/* Hiển thị tọa độ GPS */}
          <div style={{ marginBottom: 20 }}>
            {coords ? (
              <Tag color="cyan" icon={<AimOutlined />}>
                Tọa độ GPS chi nhánh: {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
              </Tag>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                <EnvironmentOutlined /> Chưa có tọa độ GPS (hệ thống sẽ tự động geocode từ địa chỉ qua Mapbox)
              </Text>
            )}
          </div>

          <Divider orientation="left">Chính sách giao trễ</Divider>
          <Alert
            type="info"
            showIcon
            message="Không có hạn giao cứng. Đơn được miễn phạt trong số ngày cấu hình; sau đó mức phạt tăng tuyến tính theo thời gian giao trễ."
            style={{ marginBottom: 12 }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr 1fr', gap: 12 }}>
            <Form.Item
              label="Số ngày miễn phạt"
              name="deliveryGraceDays"
              rules={[{ required: true }]}
            >
              <InputNumber min={0} max={365} precision={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="Cách tính phạt" name="lateDeliveryPenaltyMode">
              <Select
                options={[
                  { value: 'NONE', label: 'Không áp dụng' },
                  { value: 'FIXED_PER_DAY', label: 'Số tiền cố định / ngày' },
                  {
                    value: 'PERCENT_ORDER_VALUE_PER_DAY',
                    label: '% giá trị đơn / ngày',
                  },
                ]}
              />
            </Form.Item>
            <Form.Item
              noStyle
              shouldUpdate={(previous, current) =>
                previous.lateDeliveryPenaltyMode !== current.lateDeliveryPenaltyMode
              }
            >
              {({ getFieldValue }) => {
                const mode = getFieldValue('lateDeliveryPenaltyMode');
                return (
                  <Form.Item
                    label={mode === 'PERCENT_ORDER_VALUE_PER_DAY' ? 'Mức phạt (%)' : 'Mức phạt (₫)'}
                    name="lateDeliveryPenaltyValue"
                    rules={[{ required: mode !== 'NONE' }]}
                  >
                    <InputNumber
                      min={0}
                      max={mode === 'PERCENT_ORDER_VALUE_PER_DAY' ? 100 : undefined}
                      precision={mode === 'PERCENT_ORDER_VALUE_PER_DAY' ? 2 : 0}
                      disabled={mode === 'NONE'}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                );
              }}
            </Form.Item>
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
        title={`Chọn Vị Trí Chi Nhánh: ${branch.name}`}
        initialLocation={{
          address: form.getFieldValue('address') || branch.address,
          latitude: coords?.lat ?? branch.latitude,
          longitude: coords?.lng ?? branch.longitude,
        }}
        onCancel={() => setIsMapPickerOpen(false)}
        onSelectLocation={handleSelectFromMap}
      />
    </>
  );
};
