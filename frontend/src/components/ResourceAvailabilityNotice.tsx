import { useEffect, useState } from 'react';
import { Alert, Button, Space } from 'antd';
import { fleetApi } from '../api/fleet';
import { apiErrorMessage } from '../api/client';
import { fleetReasonLabels } from '../types/fleet';
export function ResourceAvailabilityNotice({ vehicleId, driverId, startsAt, endsAt }: { vehicleId: string; driverId: string; startsAt: string; endsAt: string }) {
  const [summary, setSummary] = useState<string[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => { let active = true; setSummary([]); setError('');
    if (!vehicleId || !driverId) return;
    setLoading(true);
    Promise.all([fleetApi.resourceWindow('vehicles', vehicleId, { startsAt, endsAt }), fleetApi.resourceWindow('drivers', driverId, { startsAt, endsAt })])
      .then(results => { if (active) setSummary(results.flatMap((r, index) => r.reasons.map(reason => `${index === 0 ? 'Xe' : 'Tài xế'}: ${fleetReasonLabels[reason] ?? 'Cần đối chiếu điều kiện tài nguyên'}`))); })
      .catch(e => { if (active) setError(apiErrorMessage(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [vehicleId, driverId, startsAt, endsAt, retry]);
  return <Alert type={error ? 'error' : 'warning'} style={{ marginBottom: 16 }} message={loading ? 'Đang đối chiếu hồ sơ và lịch…' : 'Danh sách chọn chỉ là ứng viên; phân công/publish phải kiểm tra lại'} description={<Space direction="vertical">{error || 'Chưa kiểm tra vị trí thực tế, thời gian đến nhận việc, chính sách lái/nghỉ và xếp/dỡ.'}{summary.map(s => <span key={s}>{s}</span>)}<Button size="small" onClick={() => setRetry(n => n + 1)}>Đối chiếu lại lịch</Button></Space>} />;
}
