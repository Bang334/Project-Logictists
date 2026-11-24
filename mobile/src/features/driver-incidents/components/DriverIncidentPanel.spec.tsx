import { act, fireEvent, render } from '@testing-library/react-native';
import type { DriverIncident } from '@/features/driver-incidents/types/driver-incident.types';
import type { DriverTripDetail } from '@/features/driver-trips/types/driver-trip.types';
import { useCreateDriverIncident } from '@/features/driver-incidents/hooks/useCreateDriverIncident';
import { useDriverIncidents } from '@/features/driver-incidents/hooks/useDriverIncidents';
import { DriverIncidentCard } from './DriverIncidentCard';
import { DriverIncidentForm } from './DriverIncidentForm';
import { DriverIncidentPanel } from './DriverIncidentPanel';

jest.mock('@/features/driver-incidents/hooks/useDriverIncidents', () => ({
  useDriverIncidents: jest.fn(),
}));
jest.mock('@/features/driver-incidents/hooks/useCreateDriverIncident', () => ({
  useCreateDriverIncident: jest.fn(),
}));

const reload = jest.fn(async () => undefined);
const loadMore = jest.fn(async () => undefined);
const submit = jest.fn(async () => true);
const clearError = jest.fn();

const trip: DriverTripDetail = {
  id: 'trip-1',
  tripNumber: 'TRIP-001',
  status: 'IN_PROGRESS',
  version: 2,
  plannedStartTime: '2026-11-18T01:00:00.000Z',
  plannedEndTime: '2026-11-18T03:00:00.000Z',
  actualStartTime: '2026-11-18T01:05:00.000Z',
  actualEndTime: null,
  totalDistanceKm: 20,
  totalDurationMinutes: 120,
  vehicle: {
    id: 'vehicle-1',
    plateNumber: '51C-001',
    model: 'Hino',
    vehicleType: 'Truck',
  },
  assignment: {
    id: 'assignment-1',
    role: 'PRIMARY',
    status: 'ASSIGNED',
    startTime: '2026-11-18T01:00:00.000Z',
    endTime: '2026-11-18T03:00:00.000Z',
  },
  stopCount: 1,
  stops: [
    {
      id: 'stop-1',
      sequence: 1,
      stopType: 'PICKUP',
      status: 'PENDING',
      address: 'A',
      latitude: 10,
      longitude: 106,
      contactName: null,
      contactPhone: null,
      plannedArrivalTime: null,
      plannedDepartureTime: null,
      actualArrivalTime: null,
      actualDepartureTime: null,
      tasks: [
        {
          id: 'task-1',
          action: 'LOAD',
          plannedQuantity: 1,
          actualQuantity: null,
          order: { id: 'order-1', orderNumber: 'ORD-001' },
          package: null,
        },
        {
          id: 'task-2',
          action: 'LOAD',
          plannedQuantity: 1,
          actualQuantity: null,
          order: { id: 'order-2', orderNumber: 'ORD-002' },
          package: null,
        },
      ],
    },
  ],
};

const incident: DriverIncident = {
  id: 'incident-1',
  tripId: 'trip-1',
  type: 'VEHICLE_BREAKDOWN',
  severity: 'HIGH',
  status: 'OPEN',
  description: 'Động cơ quá nhiệt, xe cần dừng kiểm tra.',
  occurredAt: '2026-11-18T01:30:00.000Z',
  createdAt: '2026-11-18T01:31:00.000Z',
  updatedAt: '2026-11-18T01:31:00.000Z',
  resolution: null,
  affectedOrders: [{ id: 'order-1', orderNumber: 'ORD-001' }],
};

describe('DriverIncidentPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(useDriverIncidents).mockReturnValue({
      items: [],
      isLoading: false,
      isLoadingMore: false,
      error: null,
      hasMore: false,
      reload,
      loadMore,
    });
    jest.mocked(useCreateDriverIncident).mockReturnValue({
      submit,
      isSubmitting: false,
      error: null,
      hasUncertainSubmission: false,
      clearError,
    });
  });

  it('hiển thị empty state và nút create cho PRIMARY active Trip', async () => {
    const view = await render(
      <DriverIncidentPanel trip={trip} reloadTrip={reload} />,
    );
    expect(
      view.getByText('Chưa có sự cố nào được báo cho chuyến này.'),
    ).toBeTruthy();
    expect(view.getByText('Báo sự cố')).toBeTruthy();
  });

  it.each([
    { assignment: { ...trip.assignment, role: 'RELIEF' } },
    { status: 'COMPLETED' as const },
    { status: 'CANCELLED' as const },
  ])('ẩn create button khi không được phép %#', async (override) => {
    const view = await render(
      <DriverIncidentPanel
        trip={{ ...trip, ...override }}
        reloadTrip={reload}
      />,
    );
    expect(view.queryByText('Báo sự cố')).toBeNull();
  });

  it('hiển thị nhiều Incident, load more và refresh', async () => {
    jest.mocked(useDriverIncidents).mockReturnValue({
      items: [incident, { ...incident, id: 'incident-2', type: 'TRAFFIC_JAM' }],
      isLoading: false,
      isLoadingMore: false,
      error: null,
      hasMore: true,
      reload,
      loadMore,
    });
    const view = await render(
      <DriverIncidentPanel trip={trip} reloadTrip={reload} />,
    );
    expect(view.getByText('Hỏng xe')).toBeTruthy();
    expect(view.getByText('Ùn tắc giao thông')).toBeTruthy();
    await act(async () => fireEvent.press(view.getByText('Xem thêm')));
    await act(async () => fireEvent.press(view.getByText('Làm mới sự cố')));
    expect(loadMore).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it('lỗi Incident list không làm panel hoặc Trip Detail crash', async () => {
    jest.mocked(useDriverIncidents).mockReturnValue({
      items: [],
      isLoading: false,
      isLoadingMore: false,
      error: 'Không tải được sự cố',
      hasMore: false,
      reload,
      loadMore,
    });
    const view = await render(
      <DriverIncidentPanel trip={trip} reloadTrip={reload} />,
    );
    expect(view.getByText('Không tải được sự cố')).toBeTruthy();
    expect(view.getByText('Thử tải lại sự cố')).toBeTruthy();
  });

  it('mở form với unique affected Orders lấy từ Trip', async () => {
    const view = await render(
      <DriverIncidentPanel trip={trip} reloadTrip={reload} />,
    );
    await act(async () => fireEvent.press(view.getByText('Báo sự cố')));
    expect(view.getByText('ORD-001')).toBeTruthy();
    expect(view.getByText('ORD-002')).toBeTruthy();
  });

  it('chặn gửi khi offline trong lúc form đã mở và giữ mô tả đến khi có mạng', async () => {
    const online = <DriverIncidentPanel trip={trip} reloadTrip={reload} />;
    const view = await render(online);
    await fireEvent.press(view.getByText('Báo sự cố'));
    const description = 'Sự cố giao thông đường phía trước.';
    await fireEvent.changeText(view.getByLabelText('Mô tả sự cố'), description);
    await view.rerender(<DriverIncidentPanel trip={trip} reloadTrip={reload} isOnline={false} />);
    expect(view.getByDisplayValue(description)).toBeTruthy();
    expect(view.getByRole('button', { name: 'Gửi báo cáo' })).toBeDisabled();
    await view.rerender(online);
    expect(view.getByRole('button', { name: 'Gửi báo cáo' })).toBeEnabled();
    expect(view.getByDisplayValue(description)).toBeTruthy();
  });
});

describe('DriverIncidentForm and card', () => {
  it('thu gọn mô tả dài và giữ nguyên nội dung khi mở chi tiết', async () => {
    const description = 'Sự cố an toàn vận tải cần điều phối theo dõi và phản hồi. '.repeat(12);
    const view = await render(<DriverIncidentCard incident={{ ...incident, description }} />);
    expect(view.getByText(description.trim()).props.numberOfLines).toBe(2);
    await fireEvent.press(view.getByText('Xem chi tiết'));
    expect(view.getByText(description.trim()).props.numberOfLines).toBeUndefined();
    expect(view.getByRole('button', { name: /^Xem sự cố/ }).props.accessibilityState.expanded).toBe(true);
  });

  it('validation giữ form, rồi gửi type/severity/affected Order hợp lệ và đóng', async () => {
    const onSubmit = jest.fn(async () => true);
    const onClose = jest.fn();
    const view = await render(
      <DriverIncidentForm
        orders={[{ id: 'order-1', orderNumber: 'ORD-001' }]}
        isSubmitting={false}
        submitError={null}
        hasUncertainSubmission={false}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    await act(async () => fireEvent.press(view.getByText('Gửi báo cáo')));
    expect(view.getByText('Mô tả phải có ít nhất 10 ký tự.')).toBeTruthy();
    await act(async () => fireEvent.press(view.getByText('Tai nạn')));
    await act(async () => fireEvent.press(view.getByText('Nghiêm trọng')));
    await act(async () =>
      fireEvent.changeText(
        view.getByLabelText('Mô tả sự cố'),
        'Tai nạn nhẹ, chưa có người bị thương.',
      ),
    );
    await act(async () => fireEvent.press(view.getByText('ORD-001')));
    await act(async () => fireEvent.press(view.getByText('Gửi báo cáo')));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ACCIDENT',
        severity: 'CRITICAL',
        affectedOrderIds: ['order-1'],
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('detail hiển thị resolution null và resolution có dữ liệu, status lạ không crash', async () => {
    const empty = await render(<DriverIncidentCard incident={incident} />);
    await act(async () => fireEvent.press(empty.getByText('Xem chi tiết')));
    expect(empty.getByText('Chưa có kết quả xử lý.')).toBeTruthy();

    const resolved = await render(
      <DriverIncidentCard
        incident={{
          ...incident,
          id: 'incident-2',
          status: 'CUSTOM',
          resolution: 'Đã điều xe cứu hộ.',
        }}
      />,
    );
    expect(resolved.getByText('Trạng thái: CUSTOM')).toBeTruthy();
    await act(async () => fireEvent.press(resolved.getByText('Xem chi tiết')));
    expect(resolved.getByText('Đã điều xe cứu hộ.')).toBeTruthy();
  });
});
