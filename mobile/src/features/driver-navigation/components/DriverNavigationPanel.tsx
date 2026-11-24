import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  EXTERNAL_NAVIGATION_OPEN_FAILED_MESSAGE,
  ExternalNavigationError,
  INVALID_NAVIGATION_COORDINATE_MESSAGE,
  openExternalNavigation,
} from "@/features/driver-navigation/services/external-navigation.service";
import type { DriverNavigationSelection } from "@/features/driver-navigation/types/driver-navigation.types";
import { driverStopTypeLabel } from "@/features/driver-trips/components/DriverTripStatusBadge";
import { PrimaryButton } from "@/shared/components/PrimaryButton";
import { ScreenMessage } from "@/shared/components/ScreenMessage";
import { colors, spacing } from "@/shared/theme/theme";

export function DriverNavigationPanel({
  target,
  compact = false,
  actionLabel = "Điều hướng",
}: {
  target: DriverNavigationSelection | null;
  compact?: boolean;
  actionLabel?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const openingRef = useRef(false);

  if (!target) return null;

  const navigate = async () => {
    if (!target.coordinateValid || target.blockedReason || openingRef.current) {
      return;
    }
    openingRef.current = true;
    setIsOpening(true);
    setError(null);
    try {
      await openExternalNavigation(target.stop);
    } catch (caughtError) {
      setError(
        caughtError instanceof ExternalNavigationError
          ? caughtError.message
          : EXTERNAL_NAVIGATION_OPEN_FAILED_MESSAGE,
      );
    } finally {
      openingRef.current = false;
      setIsOpening(false);
    }
  };

  const disabled = !target.coordinateValid || target.blockedReason !== null;
  if (compact) {
    const message = target.blockedReason ?? (!target.coordinateValid ? INVALID_NAVIGATION_COORDINATE_MESSAGE : error);
    return (
      <View testID="driver-navigation-panel">
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || isOpening, busy: isOpening }}
          accessibilityHint="Mở ứng dụng bản đồ ngoài" disabled={disabled || isOpening}
          onPress={() => void navigate()} style={styles.compactAction}>
          <Text style={disabled ? styles.address : styles.context}>{isOpening ? "Đang mở bản đồ…" : actionLabel}</Text>
        </Pressable>
        {message ? <Text style={styles.address}>{message}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.section} testID="driver-navigation-panel">
      <Text style={styles.title}>Điều hướng</Text>
      <Text style={styles.context}>{target.contextLabel}</Text>
      <Text style={styles.stopTitle}>
        {driverStopTypeLabel(target.stop.stopType)} · Điểm {target.stop.sequence}
      </Text>
      <Text style={styles.address}>{target.stop.address}</Text>
      {target.blockedReason ? (
        <ScreenMessage message={target.blockedReason} />
      ) : null}
      {!target.coordinateValid ? (
        <ScreenMessage message={INVALID_NAVIGATION_COORDINATE_MESSAGE} />
      ) : null}
      {error ? <ScreenMessage message={error} /> : null}
      <PrimaryButton
        label={actionLabel}
        loading={isOpening}
        disabled={disabled}
        onPress={() => void navigate()}
      />
      <Text style={styles.hint}>
        Mở ứng dụng bản đồ ngoài. Smart TMS không tự thay đổi trạng thái điểm dừng.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  compactAction: { minWidth: 48, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  section: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  context: { color: colors.primary, fontWeight: "800" },
  stopTitle: { color: colors.text, fontSize: 16, fontWeight: "800" },
  address: { color: colors.textMuted, lineHeight: 20 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
});
