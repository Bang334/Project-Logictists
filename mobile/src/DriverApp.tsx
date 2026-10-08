import React, { useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  AppState,
  Button,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { DriverStore } from "./store";

const labels = {
  ASSIGNED: "Chờ phản hồi",
  ACCEPTED: "Đã nhận",
  REJECTED: "Đã từ chối",
};
const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
    : "Chưa có";
export function DriverApp({
  store,
  manageSession = true,
  onOpen,
  onBack,
}: {
  store: DriverStore;
  manageSession?: boolean;
  onOpen?: (id: string) => void;
  onBack?: () => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState<"accept" | "reject" | null>(
      null,
    ),
    [reason, setReason] = useState("");
  useEffect(() => {
    if (!manageSession) return;
    void store.restore();
    const listener = AppState.addEventListener("change", (next) => {
      if (next === "active") void store.restore();
    });
    return () => listener.remove();
  }, [store, manageSession]);
  useEffect(() => store.subscribe(() => {
    if (!store.snapshot().authenticated) {
      setPassword("");
      setConfirmation(null);
      setReason("");
    }
  }), [store]);
  const detail = state.detail;
  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          state.profile && !detail ? (
            <RefreshControl
              refreshing={state.loadingList}
              onRefresh={() => void store.loadList()}
            />
          ) : undefined
        }
      >
        <Text style={s.brand}>TMS · Tài xế</Text>
        {state.error && (
          <Text accessibilityRole="alert" style={s.error}>
            {state.error}
          </Text>
        )}
        {state.notice && <Text style={s.notice}>{state.notice}</Text>}
        {state.restoring ? (
          <>
            <ActivityIndicator accessibilityLabel="Kiểm tra phiên" />
            <Text>Đang kiểm tra phiên…</Text>
          </>
        ) : !state.authenticated ? (
          <>
            <Text style={s.title}>Đăng nhập</Text>
            <Text>Tên đăng nhập</Text>
            <TextInput
              style={s.input}
              accessibilityLabel="Tên đăng nhập"
              autoCapitalize="none"
              autoCorrect={false}
              value={username}
              onChangeText={setUsername}
              editable={!state.busy}
              maxLength={100}
            />
            <Text>Mật khẩu</Text>
            <TextInput
              style={s.input}
              accessibilityLabel="Mật khẩu"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              editable={!state.busy}
              maxLength={72}
              onSubmitEditing={() => void store.login(username, password)}
            />
            <Button
              title={state.busy ? "Đang đăng nhập…" : "Đăng nhập"}
              disabled={state.busy}
              onPress={() => void store.login(username, password)}
            />
          </>
        ) : (
          <>
            <View style={s.row}>
              <Text>
                {state.profile?.fullName ?? "Phiên chưa được xác minh"}
              </Text>
              <Button
                title="Đăng xuất"
                disabled={state.busy}
                onPress={() => void store.logout()}
              />
            </View>
            {!state.profile ? (
              <Button
                title="Kiểm tra lại phiên"
                disabled={state.busy}
                onPress={() => void store.restore()}
              />
            ) : detail || state.loadingDetail ? (
              <>
                <Button
                  title="Về danh sách"
                  disabled={state.busy || !!state.intent}
                  onPress={() => {
                    if (onBack) onBack();
                    else store.back();
                    setConfirmation(null);
                    setReason("");
                  }}
                />
                {state.loadingDetail && (
                  <ActivityIndicator accessibilityLabel="Đang tải chi tiết" />
                )}
                {detail && (
                  <>
                    <Text style={s.title}>{detail.trip.tripNumber}</Text>
                    <Text style={s.badge}>{labels[detail.status]}</Text>
                    <Text>Trạng thái chuyến: {detail.trip.status}</Text>
                    <Text>Xe: {detail.trip.vehicle.plateNumber}</Text>
                    <Text>
                      {time(detail.trip.plannedStartTime)} →{" "}
                      {time(detail.trip.plannedEndTime)}
                    </Text>
                    <Text>
                      Kế hoạch v{detail.trip.version} · Phân công v
                      {detail.version}
                    </Text>
                    {detail.rejectionReason && (
                      <Text>Lý do: {detail.rejectionReason}</Text>
                    )}
                    {detail.trip.stops.map((stop) => (
                      <View key={stop.id} style={s.card}>
                        <Text style={s.subtitle}>
                          {stop.sequence}. {stop.address}
                        </Text>
                        <Text>
                          {stop.latitude}, {stop.longitude}
                        </Text>
                        <Text>Dự kiến: {time(stop.plannedArrivalTime)}</Text>
                        <Text>
                          Liên hệ: {stop.contactName ?? "Chưa có"} ·{" "}
                          {stop.contactPhone ?? "Chưa có"}
                        </Text>
                        {stop.tasks.map((task) => (
                          <View key={task.id} style={s.task}>
                            <Text style={s.subtitle}>
                              {task.action === "LOAD"
                                ? "Lấy hàng"
                                : "Giao hàng"}{" "}
                              · {task.plannedQuantity} kiện
                            </Text>
                            <Text>
                              Đơn: {task.order?.orderNumber ?? "Chưa có"} ·
                              Kiện: {task.package?.packageCode ?? "Chưa có"}
                            </Text>
                            <Text>{task.description}</Text>
                            <Text>
                              Kích thước (mm): {task.package?.lengthMm ?? "?"} ×{" "}
                              {task.package?.widthMm ?? "?"} ×{" "}
                              {task.package?.heightMm ?? "?"} ·{" "}
                              {task.package?.weightG ?? "?"} g
                            </Text>
                            <Text>
                              Khung bắt đầu phục vụ: {time(task.windowStart)} →{" "}
                              {time(task.windowEnd)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ))}
                    {detail.status === "ASSIGNED" &&
                      detail.trip.status === "DISPATCHED" &&
                      !state.intent && (
                        <>
                          <View style={s.row}>
                            <Button
                              title="Nhận chuyến"
                              disabled={state.busy}
                              onPress={() => setConfirmation("accept")}
                            />
                            <Button
                              title="Từ chối chuyến"
                              disabled={state.busy}
                              color="#9c2727"
                              onPress={() => setConfirmation("reject")}
                            />
                          </View>
                          {confirmation && (
                            <View style={s.card}>
                              <Text style={s.subtitle}>
                                {confirmation === "accept"
                                  ? "Xác nhận nhận chuyến này?"
                                  : "Xác nhận từ chối chuyến này?"}
                              </Text>
                              {confirmation === "reject" && (
                                <TextInput
                                  accessibilityLabel="Lý do từ chối"
                                  placeholder="Lý do từ chối (bắt buộc)"
                                  multiline
                                  style={s.input}
                                  maxLength={1000}
                                  value={reason}
                                  onChangeText={setReason}
                                  editable={!state.busy}
                                />
                              )}
                              <Button
                                title="Xác nhận"
                                disabled={
                                  state.busy ||
                                  (confirmation === "reject" && !reason.trim())
                                }
                                onPress={() => {
                                  const action = confirmation;
                                  setConfirmation(null);
                                  void store.respond(action, reason);
                                }}
                              />
                              <Button
                                title="Quay lại"
                                disabled={state.busy}
                                onPress={() => setConfirmation(null)}
                              />
                            </View>
                          )}
                        </>
                      )}
                  </>
                )}
              </>
            ) : (
              <>
                <Text style={s.title}>Chuyến của tôi</Text>
                <Text>Giờ Việt Nam (UTC+7)</Text>
                {state.loadingList && (
                  <ActivityIndicator accessibilityLabel="Đang tải danh sách" />
                )}
                <Button
                  title="Tải lại danh sách"
                  disabled={state.loadingList}
                  onPress={() => void store.loadList(state.list?.page)}
                />
                {state.list?.data.length === 0 && (
                  <Text style={s.card}>Chưa có chuyến được phân công.</Text>
                )}
                {state.list?.data.map((item) => (
                  <View key={item.id} style={s.card}>
                    <Text style={s.subtitle}>{item.trip.tripNumber}</Text>
                    <Text style={s.badge}>{labels[item.status]}</Text>
                    <Text>
                      {time(item.startTime)} → {time(item.endTime)}
                    </Text>
                    <Text>Xe: {item.trip.vehicle.plateNumber}</Text>
                    <Text>
                      {item.trip.start?.address ?? "Chưa có điểm đầu"} →{" "}
                      {item.trip.end?.address ?? "Chưa có điểm cuối"}
                    </Text>
                    <Button
                      title={`Xem ${item.trip.tripNumber}`}
                      disabled={!!state.intent || state.busy}
                      onPress={() => {
                        setConfirmation(null);
                        setReason("");
                        if (onOpen) onOpen(item.id);
                        else void store.open(item.id);
                      }}
                    />
                  </View>
                ))}
                {state.list && (
                  <View style={s.row}>
                    <Button
                      title="Trang trước"
                      disabled={state.loadingList || state.list.page <= 1}
                      onPress={() =>
                        void store.loadList((state.list?.page ?? 1) - 1)
                      }
                    />
                    <Text>
                      Trang {state.list.page} · {state.list.total} chuyến
                    </Text>
                    <Button
                      title="Trang sau"
                      disabled={
                        state.loadingList ||
                        state.list.page * state.list.limit >= state.list.total
                      }
                      onPress={() =>
                        void store.loadList((state.list?.page ?? 1) + 1)
                      }
                    />
                  </View>
                )}
              </>
            )}
            {state.intent && (
              <View style={s.card}>
                <Text>
                  Phản hồi{" "}
                  {state.intent.action === "accept" ? "nhận" : "từ chối"} chưa
                  được xác nhận. Thử lại cùng yêu cầu để tránh gửi trùng.
                </Text>
                <Button
                  title="Thử lại phản hồi"
                  disabled={state.busy}
                  onPress={() =>
                    void store.respond(state.intent?.action ?? "accept")
                  }
                />
              </View>
            )}
          </>
        )}
        {state.busy && <ActivityIndicator accessibilityLabel="Đang xử lý" />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f1f5f9" },
  content: { padding: 20, paddingTop: 20, paddingBottom: 24, gap: 14 },
  brand: { color: "#155e75", fontWeight: "700", fontSize: 18 },
  title: { fontWeight: "700", fontSize: 26, color: "#0f172a" },
  subtitle: { fontWeight: "600", fontSize: 17 },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  card: { backgroundColor: "white", padding: 18, borderRadius: 12, gap: 10 },
  task: {
    borderTopColor: "#dbe3eb",
    borderTopWidth: 1,
    paddingTop: 10,
    gap: 8,
  },
  input: {
    backgroundColor: "white",
    borderColor: "#64748b",
    borderWidth: 1,
    padding: 14,
    borderRadius: 8,
    minHeight: 48,
  },
  error: {
    color: "#991b1b",
    backgroundColor: "#fee2e2",
    padding: 14,
    borderRadius: 8,
  },
  notice: { color: "#164e63", backgroundColor: "#cffafe", padding: 14 },
  badge: { color: "#155e75", fontWeight: "600" },
});
