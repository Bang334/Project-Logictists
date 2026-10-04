import {
  OptimizationJobProgressUI,
  OptimizationJobStatusUI,
} from '../types';

type ProgressInput = {
  status: OptimizationJobStatusUI;
  progress: OptimizationJobProgressUI | null;
};

export type OptimizationProgressView = {
  currentStep: number;
  title: string;
  message: string;
};

const metricSummary = (details: OptimizationJobProgressUI['details']) => {
  const parts: string[] = [];
  if (details.orderCount !== undefined) parts.push(`${details.orderCount} đơn`);
  if (details.packageCount !== undefined) parts.push(`${details.packageCount} kiện`);
  if (details.physicalVehicleCount !== undefined) {
    parts.push(`${details.physicalVehicleCount} xe`);
  }
  if (details.driverCount !== undefined) parts.push(`${details.driverCount} tài xế`);
  if (details.serviceSlotCount !== undefined) {
    parts.push(`${details.serviceSlotCount} khung xe-ngày`);
  }
  return parts.join(' · ');
};

export const formatElapsedTime = (totalSeconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return minutes > 0 ? `${minutes} phút ${seconds} giây` : `${seconds} giây`;
};

export const buildOptimizationProgressView = ({
  status,
  progress,
}: ProgressInput): OptimizationProgressView => {
  if (status === 'PENDING') {
    return {
      currentStep: 0,
      title: 'Đang chờ worker tiếp nhận',
      message: 'Job đã được lưu bền vững và đang chờ đến lượt xử lý.',
    };
  }
  if (status === 'RETRYING') {
    return {
      currentStep: 0,
      title: 'Đang chờ thử lại an toàn',
      message: 'Lần chạy trước gặp lỗi tạm thời; hệ thống sẽ thử lại có giới hạn.',
    };
  }
  if (status === 'CANCEL_REQUESTED') {
    return {
      currentStep: 0,
      title: 'Đang yêu cầu dừng job',
      message: 'Kết quả đến sau yêu cầu hủy sẽ không được ghi nhận.',
    };
  }

  const details = progress?.details ?? {};
  const metrics = metricSummary(details);
  switch (progress?.stage) {
    case 'BUILDING_MATRIX':
      return {
        currentStep: 1,
        title: 'Đang dựng ma trận đường bộ',
        message: `${metrics || 'Dữ liệu đầu vào đã sẵn sàng'} · đang lấy quãng đường và thời gian thực tế từ Mapbox.`,
      };
    case 'SEARCHING_SOLUTIONS':
      return {
        currentStep: 2,
        title: 'Đang tìm và so sánh phương án',
        message: `${metrics || 'Snapshot đã được khóa'} · OR-Tools đang đánh giá các cách ghép chuyến và thứ tự lấy–giao.`,
      };
    case 'BUILDING_ROUTE_GEOMETRY':
      return {
        currentStep: 3,
        title: 'Đang hoàn thiện lộ trình ứng viên',
        message: `${details.candidateCount ?? 0} phương án đã qua solver · đang dựng đường đi Mapbox cho từng tuyến.`,
      };
    case 'SAVING_RESULTS':
      return {
        currentStep: 4,
        title: 'Đang kiểm tra và lưu kết quả',
        message: 'Đang ghi các phương án đã xếp hạng để có thể tải lại và so sánh.',
      };
    case 'COMPLETED':
      return {
        currentStep: 4,
        title: 'Đã hoàn tất tối ưu',
        message: 'Kết quả đã được lưu và sẵn sàng để kiểm tra.',
      };
    case 'LOADING_INPUT':
    case 'QUEUED':
    default:
      return {
        currentStep: 0,
        title: 'Đang đọc dữ liệu điều phối',
        message: 'Đang kiểm tra đơn, kiện, xe, tài xế và cửa sổ thời gian mới nhất.',
      };
  }
};
