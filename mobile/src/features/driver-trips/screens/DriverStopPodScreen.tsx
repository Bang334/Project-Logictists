import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { DriverTripSupportScreen } from '../components/DriverTripSupportScreen';
import { DriverPodPanel } from '../components/pod/DriverPodPanel';
import { useDriverTripWorkspace } from '../providers/DriverTripWorkspace';

export function DriverStopPodScreen() {
  const { stopId, attemptId } = useLocalSearchParams<{ stopId?: string; attemptId?: string }>();
  const { isOnline, error, recordPodUploadActivity, podUploadStore } = useDriverTripWorkspace();
  const [isSigning, setIsSigning] = useState(false);
  return (
    <DriverTripSupportScreen compact title="e-POD" scrollEnabled={!isSigning}>
      {(trip) => {
        const stop = typeof stopId === 'string' ? trip.stops.find((item) => item.id === stopId) : undefined;
        if (!stop || stop.stopType !== 'DELIVERY') {
          return <ScreenMessage message="Không tìm thấy điểm giao thuộc chuyến này." />;
        }
        if (stop.status !== 'COMPLETED' || !stop.deliveryAttempt) {
          return <ScreenMessage message="Cần đồng bộ lần giao với máy chủ trước khi thêm bằng chứng." />;
        }
        if (attemptId !== undefined && attemptId !== stop.deliveryAttempt.id) {
          return <ScreenMessage message="Lần giao không còn khớp. Mở lại bằng chứng từ điểm dừng." />;
        }
        if (trip.assignment.role !== 'PRIMARY' || trip.assignment.status !== 'ASSIGNED') {
          return <ScreenMessage message="Chỉ tài xế chính được phân công mới có quyền xem bằng chứng của chuyến." />;
        }
        const canEdit = trip.status === 'IN_PROGRESS';
        return (
          <>
            {!isOnline ? <ScreenMessage message="Cần kết nối mạng để tải bằng chứng lên." /> : null}
            <DriverPodPanel tripId={trip.id} stop={stop} readOnly={!canEdit || !isOnline || !!error}
              onUploadChange={recordPodUploadActivity} onSignatureInteractionChange={setIsSigning}
              uploadStore={podUploadStore} />
          </>
        );
      }}
    </DriverTripSupportScreen>
  );
}
