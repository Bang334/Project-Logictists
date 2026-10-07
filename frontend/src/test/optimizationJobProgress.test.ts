import { describe, expect, it } from 'vitest';
import {
  buildOptimizationProgressView,
  formatElapsedTime,
} from '../utils/optimizationJobProgress';

describe('optimization job progress view', () => {
  it('shows the persisted backend stage and real snapshot metrics', () => {
    const view = buildOptimizationProgressView({
      status: 'RUNNING',
      progress: {
        stage: 'SEARCHING_SOLUTIONS',
        updatedAt: '2026-10-04T08:00:05.000Z',
        details: {
          orderCount: 16,
          packageCount: 297,
          physicalVehicleCount: 3,
          driverCount: 4,
          serviceSlotCount: 21,
        },
      },
    });

    expect(view.currentStep).toBe(2);
    expect(view.title).toBe('Đang tìm và so sánh phương án');
    expect(view.message).toContain('16 đơn');
    expect(view.message).toContain('297 kiện');
    expect(view.message).toContain('21 khung xe-ngày');
  });

  it('does not pretend a queued or retrying job is already solving', () => {
    expect(
      buildOptimizationProgressView({ status: 'PENDING', progress: null }).title,
    ).toBe('Đang chờ worker tiếp nhận');
    expect(
      buildOptimizationProgressView({ status: 'RETRYING', progress: null }).title,
    ).toBe('Đang chờ thử lại an toàn');
  });

  it('formats elapsed time without inventing a completion percentage', () => {
    expect(formatElapsedTime(8)).toBe('8 giây');
    expect(formatElapsedTime(72)).toBe('1 phút 12 giây');
  });
});
