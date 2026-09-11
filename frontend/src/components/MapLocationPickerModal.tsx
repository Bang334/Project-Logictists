import React, { useEffect, useRef, useState } from 'react';
import { Modal, Input, Button, Space, Typography, Card, Spin, AutoComplete, Tag, Row, Col, Alert } from 'antd';
import {
  EnvironmentOutlined,
  AimOutlined,
  SearchOutlined,
  CheckOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxApi } from '../api/client';

const { Text, Title } = Typography;

interface MapLocationPickerModalProps {
  open: boolean;
  onCancel: () => void;
  onSelectLocation: (result: { address: string; latitude: number; longitude: number }) => void;
  initialLocation?: {
    address?: string;
    latitude?: number;
    longitude?: number;
  };
  title?: string;
}

export const MapLocationPickerModal: React.FC<MapLocationPickerModalProps> = ({
  open,
  onCancel,
  onSelectLocation,
  initialLocation,
  title = 'Chọn Vị Trí Trên Bản Đồ',
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  const [coords, setCoords] = useState<{ lat: number; lng: number }>({
    lat: initialLocation?.latitude && initialLocation.latitude !== 0 ? initialLocation.latitude : 21.0285,
    lng: initialLocation?.longitude && initialLocation.longitude !== 0 ? initialLocation.longitude : 105.8542,
  });
  const [address, setAddress] = useState<string>(initialLocation?.address || '');
  const [isGeocoding, setIsGeocoding] = useState<boolean>(false);
  const [searchOptions, setSearchOptions] = useState<any[]>([]);
  const [searchValue, setSearchValue] = useState<string>('');

  // Hàm reverse geocode khi marker đổi tọa độ
  const reverseGeocodeCoords = async (lng: number, lat: number) => {
    setIsGeocoding(true);
    try {
      const resolvedAddress = await mapboxApi.reverseGeocode(lng, lat);
      if (resolvedAddress) {
        setAddress(resolvedAddress);
      }
    } catch {
      // Giữ nguyên địa chỉ nếu không giải mã được
    } finally {
      setIsGeocoding(false);
    }
  };

  // Cập nhật vị trí Marker
  const setMarkerPosition = (lng: number, lat: number, shouldGeocode: boolean = true) => {
    setCoords({ lat, lng });

    if (markerRef.current) {
      markerRef.current.setLngLat([lng, lat]);
    }

    if (shouldGeocode) {
      void reverseGeocodeCoords(lng, lat);
    }
  };

  // Khởi tạo Mapbox Map khi Modal mở
  useEffect(() => {
    if (!open) return;

    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token) return;
    mapboxgl.accessToken = token;

    const startLng = initialLocation?.longitude && initialLocation.longitude !== 0 ? initialLocation.longitude : 105.8542;
    const startLat = initialLocation?.latitude && initialLocation.latitude !== 0 ? initialLocation.latitude : 21.0285;

    setCoords({ lat: startLat, lng: startLng });
    setAddress(initialLocation?.address || '');
    setSearchValue('');

    // Đợi Modal render DOM container xong
    const timer = setTimeout(() => {
      if (!mapContainerRef.current) return;

      if (mapRef.current) {
        mapRef.current.remove();
      }

      const map = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: [startLng, startLat],
        zoom: initialLocation?.latitude ? 14 : 11,
      });

      // Tạo marker có thể kéo thả
      const el = document.createElement('div');
      el.className = 'custom-map-picker-pin';
      el.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; cursor: grab;">
          <div style="background: #ef4444; color: white; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(239, 68, 68, 0.5); border: 2px solid white;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
          </div>
          <div style="width: 4px; height: 8px; background: #ef4444; border-radius: 2px;"></div>
        </div>
      `;

      const marker = new mapboxgl.Marker({ element: el, draggable: true })
        .setLngLat([startLng, startLat])
        .addTo(map);

      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        setMarkerPosition(lngLat.lng, lngLat.lat, true);
      });

      // Click vào bất kỳ điểm nào trên bản đồ để chuyển marker
      map.on('click', (e) => {
        const { lng, lat } = e.lngLat;
        setMarkerPosition(lng, lat, true);
      });

      map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'top-right');

      mapRef.current = map;
      markerRef.current = marker;

      // Nếu có sẵn tọa độ ban đầu nhưng chưa có địa chỉ, giải mã thử
      if (initialLocation?.latitude && !initialLocation.address) {
        void reverseGeocodeCoords(startLng, startLat);
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
    };
  }, [open, initialLocation]);

  // Tìm kiếm địa chỉ qua Geocoding để nhảy nhanh đến vị trí
  const handleSearch = async (query: string) => {
    setSearchValue(query);
    if (!query || query.length < 3) {
      setSearchOptions([]);
      return;
    }
    const results = await mapboxApi.geocode(query);
    setSearchOptions(
      results.map((r: any) => ({
        value: r.address,
        label: r.address,
        lat: r.latitude,
        lng: r.longitude,
      })),
    );
  };

  const handleSelectSearchResult = (_value: string, option: any) => {
    setSearchValue(option.value);
    setAddress(option.value);
    if (option.lat && option.lng && mapRef.current) {
      mapRef.current.flyTo({ center: [option.lng, option.lat], zoom: 15 });
      setMarkerPosition(option.lng, option.lat, false);
    }
  };

  const handleConfirm = () => {
    onSelectLocation({
      address: address.trim() || `Tọa độ (${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)})`,
      latitude: Number(coords.lat.toFixed(6)),
      longitude: Number(coords.lng.toFixed(6)),
    });
    onCancel();
  };

  return (
    <Modal
      title={
        <Space>
          <EnvironmentOutlined style={{ color: '#ef4444', fontSize: 18 }} />
          <span>{title}</span>
        </Space>
      }
      open={open}
      onCancel={onCancel}
      width={860}
      style={{ top: 20 }}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          Hủy bỏ
        </Button>,
        <Button
          key="submit"
          type="primary"
          icon={<CheckOutlined />}
          onClick={handleConfirm}
          disabled={!coords.lat || !coords.lng}
        >
          Xác nhận vị trí này
        </Button>,
      ]}
    >
      <div style={{ marginBottom: 12 }}>
        <Alert
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          message={
            <span>
              <strong>Cách chọn:</strong> Click chuột vào vị trí bất kỳ trên bản đồ hoặc kéo thả ghim màu đỏ đến vị trí kho/điểm nhận hàng chính xác. Địa chỉ sẽ được tự động giải mã.
            </span>
          }
          style={{ marginBottom: 10 }}
        />

        {/* Ô Tìm kiếm bay nhanh tới địa điểm */}
        <AutoComplete
          value={searchValue}
          options={searchOptions}
          onSearch={handleSearch}
          onSelect={handleSelectSearchResult}
          style={{ width: '100%' }}
        >
          <Input
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="Tìm nhanh địa danh, số nhà, khu công nghiệp... (ví dụ: KCN Sài Đồng, Cầu Giấy...)"
            allowClear
          />
        </AutoComplete>
      </div>

      {/* Container Bản đồ Mapbox */}
      <div
        ref={mapContainerRef}
        style={{
          width: '100%',
          height: '420px',
          borderRadius: '8px',
          overflow: 'hidden',
          border: '1px solid #e2e8f0',
          position: 'relative',
        }}
      />

      {/* Thông tin vị trí đã chọn */}
      <Card
        size="small"
        style={{
          marginTop: 12,
          background: '#f8fafc',
          border: '1px solid #cbd5e1',
          borderRadius: 8,
        }}
        styles={{ body: { padding: '12px 16px' } }}
      >
        <Row gutter={[16, 8]} align="middle">
          <Col xs={24} md={16}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              📍 Địa chỉ được giải mã tự động:
            </Text>
            <div style={{ marginTop: 2, minHeight: 22 }}>
              {isGeocoding ? (
                <Space>
                  <Spin size="small" />
                  <Text type="secondary" italic>
                    Đang giải mã địa chỉ từ Mapbox...
                  </Text>
                </Space>
              ) : (
                <Text strong style={{ color: '#0f172a', fontSize: 13 }}>
                  {address || 'Chưa xác định tên đường (Click lên bản đồ để chọn)'}
                </Text>
              )}
            </div>
          </Col>
          <Col xs={24} md={8} style={{ textAlign: 'right' }}>
            <Space size={6} wrap>
              <Tag color="blue">Lat: {coords.lat.toFixed(5)}</Tag>
              <Tag color="cyan">Lng: {coords.lng.toFixed(5)}</Tag>
            </Space>
          </Col>
        </Row>
      </Card>
    </Modal>
  );
};
