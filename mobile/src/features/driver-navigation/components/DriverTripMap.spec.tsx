import React from 'react';
import { fireEvent, render, within } from '@testing-library/react-native';
import { ConfiguredDriverTripMap, DriverTripMap } from './DriverTripMap';

const mockSetCamera = jest.fn();
const mockCameraSettings = jest.fn();
const mockSetAccessToken = jest.fn<Promise<null>, [string]>();

jest.mock('@rnmapbox/maps', () => {
  const ReactMock = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  const Camera = ReactMock.forwardRef((props: { defaultSettings?: unknown }, ref: React.Ref<unknown>) => {
    mockCameraSettings(props.defaultSettings);
    ReactMock.useImperativeHandle(ref, () => ({ setCamera: mockSetCamera }));
    return ReactMock.createElement(View, { testID: 'map-camera' });
  });
  return {
    __esModule: true,
    default: {
      setAccessToken: (token: string) => mockSetAccessToken(token),
      StyleURL: { Street: 'mapbox://styles/mapbox/streets-v11' },
      MapView: ({ children, onMapLoadingError, onDidFinishLoadingMap }: {
        children: React.ReactNode;
        onMapLoadingError: (event?: { type: string }) => void;
        onDidFinishLoadingMap: () => void;
      }) => ReactMock.createElement(View, { testID: 'map-view', onMapLoadingError, onDidFinishLoadingMap }, children),
      Camera,
      PointAnnotation: ({ children, id, onSelected, onDeselected }: {
        children: React.ReactNode; id: string; onSelected?: () => void; onDeselected?: () => void;
      }) => ReactMock.createElement(View, { testID: id, onSelected, onDeselected }, children),
    },
  };
});

describe('Mapbox initialization', () => {
  it('mounts the native map after configuring the token', async () => {
    mockSetAccessToken.mockResolvedValueOnce(null);
    const view = await render(
      <ConfiguredDriverTripMap accessToken="pk.test" markers={[]} driverLocation={null} />,
    );
    expect(await view.findByTestId('map-view')).toBeTruthy();
    expect(mockSetAccessToken).toHaveBeenCalledWith('pk.test');
  });

  it('shows the initialization error without mounting the map', async () => {
    mockSetAccessToken.mockRejectedValueOnce(new Error('Native initialization failed'));
    const view = await render(
      <ConfiguredDriverTripMap accessToken="pk.test" markers={[]} driverLocation={null} />,
    );
    expect(await view.findByText(/Không khởi tạo được Mapbox/)).toBeTruthy();
    expect(view.queryByTestId('map-view')).toBeNull();
  });
});

describe('DriverTripMap', () => {
  beforeEach(() => mockSetCamera.mockClear());

  it('hiển thị cả ba ký hiệu khi kho đầu, lấy hàng và kho cuối cùng tọa độ', async () => {
    const onSelectStops = jest.fn();
    const onDeselectStops = jest.fn();
    const stop = {
      address: 'QA', latitude: 10.7769, longitude: 106.7009,
      state: 'UPCOMING' as const,
    };
    const view = await render(<DriverTripMap driverLocation={null} onSelectStops={onSelectStops} onDeselectStops={onDeselectStops} markers={[
      { ...stop, id: 'start', sequence: 1, stopType: 'DEPOT_START', accessibilityLabel: 'Kho đầu' },
      { ...stop, id: 'pickup', sequence: 2, stopType: 'PICKUP', accessibilityLabel: 'Lấy hàng' },
      { ...stop, id: 'delivery', sequence: 3, stopType: 'DELIVERY', latitude: 10.8012, accessibilityLabel: 'Giao hàng' },
      { ...stop, id: 'end', sequence: 4, stopType: 'DEPOT_END', accessibilityLabel: 'Kho cuối' },
    ]} />);
    const group = within(view.getByTestId('stop-start'));
    for (const label of ['KĐ1', 'L2', 'KK4']) {
      expect(group.getByText(label)).toBeTruthy();
    }
    expect(within(view.getByTestId('stop-delivery')).getByText('G3')).toBeTruthy();
    await fireEvent(view.getByTestId('stop-start'), 'selected');
    expect(onSelectStops).toHaveBeenCalledWith(['start', 'pickup', 'end']);
    await fireEvent(view.getByTestId('stop-start'), 'deselected');
    expect(onDeselectStops).toHaveBeenCalledWith('start');
  });

  it('hiển thị marker stop và vị trí tài xế, cho phép chủ động căn camera', async () => {
    const view = await render(
      <DriverTripMap
        markers={[{
          id: 'stop-1', sequence: 1, stopType: 'PICKUP', address: 'Điểm lấy',
          latitude: 10.77, longitude: 106.7, state: 'CURRENT',
          accessibilityLabel: '1. Điểm lấy hàng, hiện tại',
        }]}
        driverLocation={{ latitude: 10.76, longitude: 106.69, measuredAt: '2026-11-19T00:00:00.000Z', isStale: false }}
      />,
    );
    expect(view.getByTestId('stop-stop-1')).toBeTruthy();
    expect(view.getByTestId('driver-location')).toBeTruthy();
    fireEvent.press(view.getByText('Vị trí của tôi'));
    expect(mockSetCamera).toHaveBeenCalledWith(expect.objectContaining({
      centerCoordinate: [106.69, 10.76], zoomLevel: 15,
    }));
  });

  it('không hiển thị nút căn vị trí khi chưa có GPS', async () => {
    const view = await render(<DriverTripMap markers={[]} driverLocation={null} />);
    expect(view.queryByText('Vị trí của tôi')).toBeNull();
  });

  it('căn các điểm khi mở và giữ camera khi điểm hiện tại hoặc GPS thay đổi', async () => {
    const markers = [
      { id: 'one', sequence: 1, stopType: 'PICKUP' as const, address: 'A',
        latitude: 10, longitude: 106, state: 'CURRENT' as const, accessibilityLabel: 'A' },
      { id: 'two', sequence: 2, stopType: 'DELIVERY' as const, address: 'B',
        latitude: 20, longitude: 107, state: 'UPCOMING' as const, accessibilityLabel: 'B' },
    ];
    const view = await render(<DriverTripMap markers={markers} targetStopId="one" driverLocation={null} />);
    const bounds = { ne: [107, 20], sw: [106, 10] };
    expect(mockCameraSettings).toHaveBeenLastCalledWith(expect.objectContaining({ bounds }));
    await view.rerender(<DriverTripMap markers={markers} targetStopId="two"
      driverLocation={{ latitude: 11, longitude: 108, measuredAt: '2026-11-19T00:00:00.000Z', isStale: false }} />);
    expect(mockCameraSettings).toHaveBeenLastCalledWith(expect.objectContaining({ bounds }));
    expect(mockSetCamera).not.toHaveBeenCalled();
  });

  it('chỉ định tâm vào vị trí cuối khi tài xế chọn nút có nhãn đã cũ', async () => {
    const view = await render(<DriverTripMap markers={[]}
      driverLocation={{ latitude: 10, longitude: 106, measuredAt: '2026-11-19T00:00:00.000Z', isStale: true }} />);
    expect(view.getByLabelText('Vị trí cuối đã cũ của tài xế')).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: 'Vị trí cuối' }));
    expect(mockSetCamera).toHaveBeenCalledWith(expect.objectContaining({ centerCoordinate: [106, 10] }));
  });

  it('báo lỗi một phần khi tile lỗi và xóa cảnh báo khi tải xong', async () => {
    const view = await render(<DriverTripMap markers={[]} driverLocation={null} />);
    await fireEvent(view.getByTestId('map-view'), 'mapLoadingError', { type: 'tile' });
    expect(view.getByText(/Một phần nền bản đồ chưa tải được/)).toBeTruthy();
    expect(view.getByTestId('map-view')).toBeTruthy();
    await fireEvent(view.getByTestId('map-view'), 'didFinishLoadingMap');
    expect(view.queryByText(/Một phần nền bản đồ chưa tải được/)).toBeNull();
  });

  it('hiện lỗi nền khi style không tải được', async () => {
    const view = await render(<DriverTripMap markers={[]} driverLocation={null} />);
    await fireEvent(view.getByTestId('map-view'), 'mapLoadingError', { type: 'style' });
    expect(view.getByText(/Không tải được nền bản đồ/)).toBeTruthy();
  });
});
