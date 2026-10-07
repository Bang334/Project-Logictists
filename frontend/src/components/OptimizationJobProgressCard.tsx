import { ClockCircleOutlined, SyncOutlined } from '@ant-design/icons';
import { Alert, Card, Space, Steps, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { AutomaticOptimizationResponseUI } from '../types';
import {
  buildOptimizationProgressView,
  formatElapsedTime,
} from '../utils/optimizationJobProgress';

const { Text } = Typography;

const ACTIVE_STATUSES = new Set([
  'PENDING',
  'RUNNING',
  'RETRYING',
  'CANCEL_REQUESTED',
]);

const STEP_ITEMS = [
  { title: 'Dữ liệu' },
  { title: 'Ma trận đường' },
  { title: 'Tìm phương án' },
  { title: 'Dựng lộ trình' },
  { title: 'Lưu kết quả' },
];

type Props = {
  job: AutomaticOptimizationResponseUI;
};

export function OptimizationJobProgressCard({ job }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const isActive = ACTIVE_STATUSES.has(job.status);

  useEffect(() => {
    if (!isActive) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const elapsedSeconds = useMemo(() => {
    const start = Date.parse(job.startedAt ?? job.createdAt);
    const end = job.completedAt ? Date.parse(job.completedAt) : now;
    return Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, Math.floor((end - start) / 1000))
      : 0;
  }, [job.completedAt, job.createdAt, job.startedAt, now]);

  if (!isActive) {
    return (
      <Alert
        type={['FAILED', 'TIMEOUT', 'CANCELLED'].includes(job.status) ? 'error' : 'info'}
        showIcon
        message={`Job tối ưu: ${job.status}`}
        description={job.error?.message}
        style={{ marginBottom: 16 }}
      />
    );
  }

  const view = buildOptimizationProgressView(job);
  const updatedAt = job.progress?.updatedAt
    ? new Date(job.progress.updatedAt).toLocaleTimeString('vi-VN')
    : null;

  return (
    <Card
      size="small"
      aria-live="polite"
      style={{ marginBottom: 16, borderColor: '#91caff', background: '#f8fbff' }}
      styles={{ body: { padding: '16px 18px' } }}
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <Space align="start">
            <SyncOutlined spin style={{ color: '#1677ff', fontSize: 18, marginTop: 3 }} />
            <div>
              <Text strong style={{ display: 'block', fontSize: 16 }}>
                {view.title}
              </Text>
              <Text type="secondary">{view.message}</Text>
            </div>
          </Space>
          <Space wrap>
            <Tag icon={<ClockCircleOutlined />} color="processing">
              Đã chạy {formatElapsedTime(elapsedSeconds)}
            </Tag>
            <Tag>Job #{job.id.slice(0, 8)}</Tag>
            {job.attemptCount > 1 && <Tag color="orange">Lần thử {job.attemptCount}</Tag>}
          </Space>
        </div>

        <Steps
          size="small"
          responsive
          current={view.currentStep}
          items={STEP_ITEMS}
        />

        <div
          style={{
            borderRadius: 8,
            border: '1px solid #dbeafe',
            background: '#ffffff',
            padding: '10px 12px',
          }}
        >
          <Text style={{ display: 'block' }}>
            {updatedAt ? `${updatedAt} · ` : ''}{view.title}
          </Text>
          <Text type="secondary" style={{ display: 'block', marginTop: 2 }}>
            Chỉ công bố phương án sau khi kiểm tra tải, thứ tự lấy–giao và khả năng xếp/dỡ.
          </Text>
          <Text type="secondary" style={{ display: 'block', marginTop: 2 }}>
            Bạn có thể tải lại trang; tiến độ và kết quả đều được đọc lại từ server.
          </Text>
        </div>
      </Space>
    </Card>
  );
}
