import type { DriverTripStop } from '@/features/driver-trips/types/driver-trip.types';
import {
  createStopExecutionForm,
  inferDeliveryResult,
  validateStopCompletion,
} from './driver-trip-execution.validation';

function stop(
  stopType: DriverTripStop['stopType'],
  plannedQuantities = [1],
): DriverTripStop {
  return {
    id: `stop-${stopType}`,
    sequence: 1,
    stopType,
    status: 'ARRIVED',
    address: 'Test address',
    latitude: 10,
    longitude: 106,
    contactName: null,
    contactPhone: null,
    plannedArrivalTime: null,
    plannedDepartureTime: null,
    actualArrivalTime: new Date().toISOString(),
    actualDepartureTime: null,
    tasks: plannedQuantities.map((plannedQuantity, index) => ({
      id: `task-${index}`,
      action: stopType === 'PICKUP' ? 'LOAD' : 'UNLOAD',
      plannedQuantity,
      actualQuantity: null,
      order: { id: 'order-1', orderNumber: 'ORD-001' },
      package: {
        id: `package-${index}`,
        packageCode: `PKG-${index}`,
        weightKg: 10,
        lengthCm: 10,
        widthCm: 10,
        heightCm: 10,
        status: stopType === 'PICKUP' ? 'ALLOCATED' : 'LOADED',
      },
    })),
  };
}

describe('driver trip execution validation', () => {
  it('pickup success dùng đủ plannedQuantity', () => {
    const pickup = stop('PICKUP', [1, 3]);
    const form = createStopExecutionForm(pickup);
    expect(validateStopCompletion(pickup, form)).toEqual({
      success: true,
      data: {
        tasks: [
          { taskId: 'task-0', actualQuantity: 1 },
          { taskId: 'task-1', actualQuantity: 3 },
        ],
        deliveryResult: null,
        reasonCode: null,
        note: null,
        recipientName: null,
      },
    });
  });

  it('pickup partial yêu cầu reasonCode và OTHER yêu cầu note', () => {
    const pickup = stop('PICKUP');
    const form = createStopExecutionForm(pickup);
    form.quantities['task-0'] = '0';
    expect(validateStopCompletion(pickup, form)).toMatchObject({ success: false });
    form.reasonCode = 'OTHER';
    expect(validateStopCompletion(pickup, form)).toMatchObject({ success: false });
    form.note = 'Không tìm thấy kiện';
    expect(validateStopCompletion(pickup, form)).toMatchObject({
      success: true,
      data: { reasonCode: 'OTHER', note: 'Không tìm thấy kiện' },
    });
  });

  it.each([
    { quantities: { 'task-0': '1', 'task-1': '2' }, result: 'SUCCESS' },
    { quantities: { 'task-0': '1', 'task-1': '0' }, result: 'PARTIAL' },
    { quantities: { 'task-0': '0', 'task-1': '0' }, result: 'FAILED' },
  ] as const)('suy ra deliveryResult $result', ({ quantities, result }) => {
    expect(inferDeliveryResult(stop('DELIVERY', [1, 2]), quantities)).toBe(result);
  });

  it('delivery partial/failed bắt buộc reason và success không cần reason', () => {
    const delivery = stop('DELIVERY', [1, 1]);
    const form = createStopExecutionForm(delivery);
    form.recipientName = 'Người nhận QA';
    expect(validateStopCompletion(delivery, form)).toMatchObject({
      success: true,
      data: { deliveryResult: 'SUCCESS' },
    });
    form.quantities['task-1'] = '0';
    expect(validateStopCompletion(delivery, form)).toMatchObject({ success: false });
    form.reasonCode = 'RECIPIENT_UNAVAILABLE';
    expect(validateStopCompletion(delivery, form)).toMatchObject({
      success: true,
      data: { deliveryResult: 'PARTIAL' },
    });
    form.quantities['task-0'] = '0';
    expect(validateStopCompletion(delivery, form)).toMatchObject({
      success: true,
      data: { deliveryResult: 'FAILED' },
    });
  });

  it.each(['-1', '0.5', '2', 'abc', ''])(
    'từ chối quantity không hợp lệ: %s',
    (quantity) => {
      const pickup = stop('PICKUP');
      const form = createStopExecutionForm(pickup);
      form.quantities['task-0'] = quantity;
      expect(validateStopCompletion(pickup, form)).toMatchObject({ success: false });
    },
  );

  it('depot stop gửi tasks rỗng', () => {
    const depot = { ...stop('DEPOT_START', []), tasks: [] };
    expect(validateStopCompletion(depot, createStopExecutionForm(depot))).toEqual({
      success: true,
      data: { tasks: [], note: null },
    });
  });
});
