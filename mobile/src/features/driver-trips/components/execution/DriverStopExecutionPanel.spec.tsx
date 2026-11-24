import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import type { DriverTripStop } from '@/features/driver-trips/types/driver-trip.types';
import { DriverStopExecutionPanel } from './DriverStopExecutionPanel';

function stop(
  stopType: DriverTripStop['stopType'],
  plannedQuantity = 1,
): DriverTripStop {
  const isDepot = stopType === 'DEPOT_START' || stopType === 'DEPOT_END';
  return {
    id: `stop-${stopType}`,
    sequence: 1,
    stopType,
    status: 'ARRIVED',
    address: 'Address',
    latitude: 10,
    longitude: 106,
    contactName: null,
    contactPhone: null,
    plannedArrivalTime: null,
    plannedDepartureTime: null,
    actualArrivalTime: '2026-11-16T01:00:00.000Z',
    actualDepartureTime: null,
    tasks: isDepot
      ? []
      : [
          {
            id: 'task-1',
            action: stopType === 'PICKUP' ? 'LOAD' : 'UNLOAD',
            plannedQuantity,
            actualQuantity: null,
            order: { id: 'order-1', orderNumber: 'ORD-001' },
            package: {
              id: 'package-1',
              packageCode: 'PKG-001',
              weightKg: 10,
              lengthCm: 10,
              widthCm: 10,
              heightCm: 10,
              status: stopType === 'PICKUP' ? 'ALLOCATED' : 'LOADED',
            },
          },
        ],
  };
}

describe('DriverStopExecutionPanel', () => {
  it('gắn lỗi số lượng vào đúng kiện trong danh sách nhiều task', async () => {
    const pickup = stop('PICKUP', 3);
    const first = pickup.tasks[0]!;
    pickup.tasks.push({ ...first, id: 'task-2' });
    const onSubmit = jest.fn(async () => true);
    const view = await render(<DriverStopExecutionPanel stop={pickup} isSubmitting={false} onSubmit={onSubmit} />);
    const row = within(view.getByTestId('stop-task-input-task-2'));
    await fireEvent.changeText(row.getByLabelText('Số lượng thực tế task-2'), '4');
    await fireEvent.press(view.getByRole('button', { name: 'Hoàn thành lấy hàng' }));
    expect(row.getByRole('alert')).toHaveTextContent('Số lượng thực tế không được vượt quá 3.');
    expect(within(view.getByTestId('stop-task-input-task-1')).queryByRole('alert')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('pickup success gửi plannedQuantity mặc định', async () => {
    const onSubmit = jest.fn(async () => true);
    const view = await render(
      <DriverStopExecutionPanel
        stop={stop('PICKUP')}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );
    await act(async () => fireEvent.press(view.getByText('Hoàn thành lấy hàng')));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          tasks: [{ taskId: 'task-1', actualQuantity: 1 }],
        }),
      ),
    );
  });

  it('pickup partial chặn khi thiếu reason rồi gửi được sau khi chọn', async () => {
    const onSubmit = jest.fn(async () => true);
    const view = await render(
      <DriverStopExecutionPanel
        stop={stop('PICKUP')}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );
    await act(async () => fireEvent.press(view.getByText('Không xử lý được: 0')));
    await act(async () => fireEvent.press(view.getByText('Hoàn thành lấy hàng')));
    expect(view.getByText('Vui lòng chọn lý do khi số lượng thực tế bị thiếu.')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => fireEvent.press(view.getByText('Không có kiện hàng')));
    await act(async () => fireEvent.press(view.getByText('Hoàn thành lấy hàng')));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          tasks: [{ taskId: 'task-1', actualQuantity: 0 }],
          reasonCode: 'PACKAGE_NOT_AVAILABLE',
        }),
      ),
    );
  });

  it('delivery failed hiển thị cảnh báo và gửi FAILED', async () => {
    const onSubmit = jest.fn(async () => true);
    const view = await render(
      <DriverStopExecutionPanel
        stop={stop('DELIVERY')}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );
    await act(async () => fireEvent.press(view.getByText('Không xử lý được: 0')));
    expect(view.getByText('Kết quả: Giao thất bại')).toBeTruthy();
    expect(view.getByText(/Kiện hàng chưa được coi là đã giao/)).toBeTruthy();
    await act(async () => fireEvent.press(view.getByText('Không gặp người nhận')));
    await act(async () => fireEvent.press(view.getByText('Xác nhận giao thất bại')));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryResult: 'FAILED',
          reasonCode: 'RECIPIENT_UNAVAILABLE',
        }),
      ),
    );
  });

  it('hỗ trợ plannedQuantity lớn hơn 1 và depot task rỗng', async () => {
    const pickupSubmit = jest.fn(async () => true);
    const pickup = await render(
      <DriverStopExecutionPanel
        stop={stop('PICKUP', 5)}
        isSubmitting={false}
        onSubmit={pickupSubmit}
      />,
    );
    await act(async () =>
      fireEvent.changeText(pickup.getByLabelText('Số lượng thực tế task-1'), '4'),
    );
    await act(async () => fireEvent.press(pickup.getByText('Sai số lượng')));
    await act(async () => fireEvent.press(pickup.getByText('Hoàn thành lấy hàng')));
    await waitFor(() =>
      expect(pickupSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          tasks: [{ taskId: 'task-1', actualQuantity: 4 }],
        }),
      ),
    );

    const depotSubmit = jest.fn(async () => true);
    const depot = await render(
      <DriverStopExecutionPanel
        stop={stop('DEPOT_START')}
        isSubmitting={false}
        onSubmit={depotSubmit}
      />,
    );
    await act(async () => fireEvent.press(depot.getByText('Hoàn thành điểm kho')));
    await waitFor(() =>
      expect(depotSubmit).toHaveBeenCalledWith({ tasks: [], note: null }),
    );
  });
});
