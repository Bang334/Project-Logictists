import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { driverTheme } from '@/shared/theme/driver-theme';

const { colors, spacing } = driverTheme;

export function DriverTripHeader({
  title,
  subtitle,
  showBack = false,
  onBack,
  actionLabel,
  onAction,
  compact = false,
}: {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <View style={compactStyles.header}>
        <View style={compactStyles.row}>
          <View style={compactStyles.leading}>
            {showBack ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Quay lại" onPress={onBack ?? (() => router.back())}
                style={compactStyles.back}>
                <Text style={styles.backLabel}>‹</Text>
              </Pressable>
            ) : null}
            <Text accessibilityRole="header" allowFontScaling style={compactStyles.title}>{title}</Text>
          </View>
          {actionLabel && onAction ? (
            <Pressable accessibilityRole="button" onPress={onAction} style={compactStyles.action}>
              <Text style={compactStyles.actionLabel}>{actionLabel}</Text>
            </Pressable>
          ) : null}
        </View>
        {subtitle ? <Text allowFontScaling style={compactStyles.subtitle}>{subtitle}</Text> : null}
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {showBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Quay lại"
            onPress={onBack ?? (() => router.back())}
            style={styles.backButton}
          >
            <Text style={styles.backLabel}>‹</Text>
          </Pressable>
        ) : null}
        <View style={styles.titleContainer}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {actionLabel && onAction ? (
          <Pressable
            accessibilityRole="button"
            onPress={onAction}
            style={styles.actionButton}
          >
            <Text style={styles.actionLabel}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const compactStyles = StyleSheet.create({
  header: { gap: spacing.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
    columnGap: spacing.sm },
  leading: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: spacing.xs },
  title: { ...driverTheme.type.title, color: colors.text, flexShrink: 1 },
  subtitle: { ...driverTheme.type.meta, color: colors.textMuted },
  back: { minWidth: driverTheme.touchTarget, minHeight: driverTheme.touchTarget,
    justifyContent: 'center', alignItems: 'center' },
  action: { minWidth: driverTheme.touchTarget, minHeight: driverTheme.touchTarget, justifyContent: 'center' },
  actionLabel: { ...driverTheme.type.meta, color: colors.primary, fontWeight: '700' },
});

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleContainer: { flex: 1 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.textMuted, marginTop: 3, lineHeight: 19 },
  backButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  backLabel: { color: colors.text, fontSize: 32, lineHeight: 34 },
  actionButton: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.primary,
  },
  actionLabel: { color: colors.surface, fontWeight: '800' },
});
