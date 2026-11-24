import { useCallback, type ReactNode } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';
import { useDriverTripWorkspace } from '../providers/DriverTripWorkspace';
import type { DriverTripDetail } from '../types/driver-trip.types';
import { DriverTripHeader } from './DriverTripHeader';

export function DriverTripSupportScreen({ title, scrollEnabled, compact = false, children }: {
  title: string;
  scrollEnabled?: boolean;
  compact?: boolean;
  children(trip: DriverTripDetail): ReactNode;
}) {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { trip, tripId, isLoading, error, reload } = useDriverTripWorkspace();
  const validTripId = typeof id === 'string' && id.length > 0 && id === tripId;
  const matchingTrip = validTripId && trip?.id === tripId ? trip : null;
  useFocusEffect(useCallback(() => {
    if (validTripId) void reload();
  }, [reload, validTripId]));

  return (
    <SafeAreaView style={styles.screen} edges={compact ? ['top', 'bottom', 'left', 'right'] : ['top', 'bottom']}>
      {compact ? (
        <View style={styles.compactHeader}><DriverTripHeader compact title={title} showBack /></View>
      ) : <DriverTripHeader title={title} subtitle={matchingTrip?.tripNumber} showBack />}
      {matchingTrip ? (
        <ScrollView contentContainerStyle={styles.content} scrollEnabled={scrollEnabled}
          keyboardShouldPersistTaps="handled">
          {error ? (
            <>
              <ScreenMessage message={error} />
              <PrimaryButton label="Tải lại chuyến" variant="secondary" onPress={() => void reload()} />
            </>
          ) : null}
          {children(matchingTrip)}
        </ScrollView>
      ) : (
        <View style={styles.center}>
          {validTripId && isLoading
            ? <ActivityIndicator color={colors.primary} accessibilityLabel="Đang tải chuyến" />
            : <ScreenMessage message={validTripId && error ? error : 'Không tìm thấy chuyến được phân công.'} />}
          {validTripId && !isLoading ? <PrimaryButton label="Thử lại" onPress={() => void reload()} /> : null}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
  compactHeader: { paddingHorizontal: spacing.md, paddingBottom: spacing.xs },
  center: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
});
