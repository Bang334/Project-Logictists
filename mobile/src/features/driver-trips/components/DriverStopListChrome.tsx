import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { driverTheme } from '@/shared/theme/driver-theme';

const { colors, spacing } = driverTheme;

export function DriverStopListHeader({ tripNumber, count, onBack }: {
  tripNumber?: string; count?: number; onBack(): void;
}) {
  return (
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="Quay lại" onPress={onBack} style={styles.iconButton}>
        <Text accessible={false} style={styles.back}>‹</Text>
      </Pressable>
      <View style={styles.headerText}>
        <Text accessibilityRole="header" style={styles.title}>Danh sách điểm dừng</Text>
        {tripNumber ? (
          <Text accessible accessibilityLabel={`Mã chuyến ${tripNumber}`} numberOfLines={1} ellipsizeMode="middle"
            style={styles.meta}>{tripNumber}</Text>
        ) : null}
      </View>
      {count !== undefined ? <Text style={styles.count}>{count} điểm</Text> : null}
    </View>
  );
}

export function DriverStopOrderBanner() {
  return (
    <View style={styles.banner}>
      <View style={styles.lockBadge} accessible={false} importantForAccessibility="no-hide-descendants">
        <View style={styles.lockShackle} />
        <View style={styles.lockBody} />
      </View>
      <Text style={styles.bannerLabel}>Điểm dừng hiển thị theo thứ tự kế hoạch.</Text>
    </View>
  );
}

export function DriverStopSearch({ value, onChangeText }: { value: string; onChangeText(value: string): void }) {
  return (
    <View style={styles.search}>
      <View style={styles.searchIcon} accessible={false} importantForAccessibility="no-hide-descendants">
        <View style={styles.lens} />
        <View style={styles.handle} />
      </View>
      <TextInput accessibilityLabel="Tìm điểm dừng" placeholder="Số điểm, địa chỉ hoặc liên hệ"
        placeholderTextColor={colors.textMuted} value={value} style={styles.input}
        returnKeyType="search" onChangeText={onChangeText} />
      {value ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Xóa tìm kiếm"
          style={styles.iconButton} onPress={() => onChangeText('')}>
          <Text accessible={false} style={styles.clear}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function DriverStopMapBar({ remaining, onOpenMap }: { remaining: number; onOpenMap(): void }) {
  return (
    <View style={styles.mapBar} testID="driver-stop-map-bar">
      <View style={styles.mapSummary}>
        <Text style={styles.remaining}>{remaining} điểm còn lại</Text>
        <Text style={styles.meta}>Theo xác nhận máy chủ</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={onOpenMap} style={styles.mapButton}>
        <Text style={styles.mapLabel}>Bản đồ chuyến</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingRight: spacing.md, paddingLeft: 4, paddingVertical: 6, backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  headerText: { flex: 1, minWidth: 0, paddingVertical: 2 },
  title: { ...driverTheme.type.strong, color: colors.text },
  meta: { ...driverTheme.type.label, color: colors.textMuted },
  count: {
    ...driverTheme.type.label, fontVariant: ['tabular-nums'], fontWeight: '700', maxWidth: '35%',
    color: colors.primary, backgroundColor: colors.infoSurface, borderRadius: driverTheme.radius.pill,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  iconButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  back: { color: colors.text, fontSize: 32, lineHeight: 36 },
  clear: { color: colors.textMuted, fontSize: 24, lineHeight: 28 },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.neutralSurface,
    borderRadius: driverTheme.radius.control, borderColor: colors.border, borderWidth: 1, padding: 10,
  },
  bannerLabel: { ...driverTheme.type.meta, fontWeight: '600', flex: 1, color: colors.primary },
  lockBadge: {
    width: 28, height: 28, borderRadius: 7, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  lockShackle: { width: 8, height: 6, borderWidth: 1.5, borderColor: colors.surface, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  lockBody: { width: 12, height: 8, borderWidth: 1.5, borderColor: colors.surface, borderRadius: 2, marginTop: -1.5 },
  search: {
    flexDirection: 'row', alignItems: 'center', minHeight: driverTheme.touchTarget, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, borderRadius: driverTheme.radius.control,
  },
  searchIcon: { width: 20, height: 20, marginLeft: 12, marginRight: 8 },
  lens: { position: 'absolute', top: 2, left: 2, width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: colors.textMuted },
  handle: { position: 'absolute', width: 7, height: 1.5, top: 13, left: 11, backgroundColor: colors.textMuted, transform: [{ rotate: '45deg' }] },
  input: { ...driverTheme.type.meta, color: colors.text, flex: 1, minHeight: driverTheme.touchTarget, paddingRight: 10, paddingVertical: 8 },
  mapBar: {
    flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: 8, backgroundColor: colors.surface,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  mapSummary: { flexGrow: 1, flexShrink: 1, minWidth: 126 },
  remaining: { ...driverTheme.type.strong, fontVariant: ['tabular-nums'], color: colors.text },
  mapButton: {
    minHeight: driverTheme.actionHeight, maxWidth: '100%', justifyContent: 'center',
    backgroundColor: colors.info, borderRadius: driverTheme.radius.control, paddingHorizontal: 16, paddingVertical: 6,
  },
  mapLabel: { ...driverTheme.type.meta, color: colors.surface, fontWeight: '700', textAlign: 'center' },
});
