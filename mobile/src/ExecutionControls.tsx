import React, { useState } from "react";
import { Button, Text, View } from "react-native";
import { AssignmentDetail } from "./contracts";
import { DriverStore } from "./store";
import { PickupControls } from "./PickupControls";

export function ExecutionControls({ detail, store, disabled }: {
  detail: AssignmentDetail; store: DriverStore; disabled: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  if (detail.status !== "ACCEPTED") return null;
  const trip = detail.trip;
  const next = trip.stops.find(stop => stop.status !== "COMPLETED");
  const starting = trip.status === "DISPATCHED";
  const arriving = trip.status === "IN_PROGRESS" && !!trip.executionSnapshot && next?.status === "PENDING";
  if (trip.status === 'IN_PROGRESS' && next?.status === 'ARRIVED') return <PickupControls stop={next} store={store} disabled={disabled} />;
  if (!starting && !arriving) return trip.status === "IN_PROGRESS" ? (
    <Text>{next?.status === "ARRIVED"
      ? "Đã đến điểm. Chờ hoàn tất nghiệp vụ tại điểm trước khi đi tiếp; pickup/delivery chưa hỗ trợ trong mốc này."
      : "Chuyến chưa cho phép ghi nhận đến điểm. Liên hệ điều phối nếu dữ liệu không đúng."}</Text>
  ) : null;
  return <View style={{ gap: 12 }}>
    {!starting && <Text>Điểm cần đến: {next?.sequence}. {next?.address}</Text>}
    <Button title={starting ? "Bắt đầu chuyến" : "Tôi đã đến điểm"} disabled={disabled} onPress={() => setConfirm(true)} />
    {confirm && <View style={{ gap: 10, padding: 14, backgroundColor: "white" }}>
      <Text>{starting ? "Xác nhận bắt đầu chuyến ngay bây giờ?" : `Xác nhận đã đến ${next?.address}?`}</Text>
      <Text>{starting ? "Thời gian thực tế được ghi khi máy chủ xác nhận. Có thể bắt đầu trước giờ kế hoạch."
        : "Đây là xác nhận thủ công của tài xế, chưa xác minh bằng GPS. Thao tác không xác nhận đã lấy/giao hàng."}</Text>
      <Button title="Xác nhận thực hiện" disabled={disabled} onPress={() => {
        setConfirm(false);
        void store.respond(starting ? "start" : "arrive", "", starting ? undefined : next?.id);
      }} />
      <Button title="Hủy xác nhận" disabled={disabled} onPress={() => setConfirm(false)} />
    </View>}
  </View>;
}
