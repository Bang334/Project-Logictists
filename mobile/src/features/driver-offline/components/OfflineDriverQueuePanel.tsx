import { StyleSheet, Text, View } from "react-native";
import type { OfflineDriverQueueSummary } from "@/features/driver-offline/types/offline-driver-command.types";
import { PrimaryButton } from "@/shared/components/PrimaryButton";
import { colors, spacing } from "@/shared/theme/theme";

interface Props {
  summary: OfflineDriverQueueSummary;
  isSyncing: boolean;
  onSync: () => Promise<void>;
  onReload: () => Promise<void>;
  hasExpiredConflict?: boolean;
  isOnline?: boolean;
}

export function OfflineDriverQueuePanel({
  summary,
  isSyncing,
  onSync,
  onReload,
  hasExpiredConflict = false,
  isOnline = true,
}: Props) {
  if (summary.totalUnsynced === 0) return null;
  const hasConflict = summary.conflict > 0;
  const hasFailed = summary.failed > 0 || summary.blocked > 0;
  return (
    <View style={styles.panel} testID="offline-driver-queue-panel">
      <Text style={styles.title}>Đồng bộ ngoại tuyến</Text>
      <Text style={styles.value}>Chờ đồng bộ: {summary.pending}</Text>
      {summary.syncing > 0 ? (
        <Text style={styles.value}>Đang đồng bộ: {summary.syncing}</Text>
      ) : null}
      {summary.conflict > 0 ? (
        <Text style={styles.value}>Xung đột: {summary.conflict}</Text>
      ) : null}
      {summary.failed + summary.blocked > 0 ? (
        <Text style={styles.value}>
          Thất bại hoặc bị chặn: {summary.failed + summary.blocked}
        </Text>
      ) : null}
      {isSyncing || summary.syncing > 0 ? (
        <Text style={styles.syncing}>Đang đồng bộ...</Text>
      ) : null}
      {hasConflict ? (
        <Text style={styles.error}>
          {hasExpiredConflict
            ? "Thao tác chờ đồng bộ đã quá thời gian cho phép. Cần kiểm tra với điều phối."
            : "Dữ liệu chuyến đã thay đổi. Cần kiểm tra lại trước khi đồng bộ."}
        </Text>
      ) : null}
      {hasFailed ? (
        <Text style={styles.error}>
          Không thể đồng bộ thao tác này. Vui lòng liên hệ điều phối.
        </Text>
      ) : null}
      {!isOnline ? <Text style={styles.value}>Kết nối mạng để đồng bộ thao tác đã lưu.</Text> : null}
      <PrimaryButton
        label="Thử đồng bộ"
        loading={isSyncing}
        disabled={!isOnline}
        onPress={() => void onSync()}
      />
      {(hasConflict || hasFailed) && (
        <PrimaryButton
          label="Tải lại chuyến"
          variant="secondary"
          onPress={() => void onReload()}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    padding: spacing.lg,
    borderRadius: 18,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  value: { color: colors.textMuted },
  syncing: { color: colors.primary, fontWeight: "700" },
  error: { color: colors.danger, lineHeight: 20 },
});
