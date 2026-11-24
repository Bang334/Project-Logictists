import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useNetInfo } from "@react-native-community/netinfo";
import { SafeAreaView } from "react-native-safe-area-context";
import { DriverTripCard } from "@/features/driver-trips/components/DriverTripCard";
import { DriverTripHeader } from "@/features/driver-trips/components/DriverTripHeader";
import { driverTripStatusLabel } from "@/features/driver-trips/components/DriverTripStatusBadge";
import { useDriverTrips } from "@/features/driver-trips/hooks/useDriverTrips";
import {
  DRIVER_TRIP_STATUSES,
  type DriverTripStatusFilter,
} from "@/features/driver-trips/types/driver-trip.types";
import { ScreenMessage } from "@/shared/components/ScreenMessage";
import { PrimaryButton } from "@/shared/components/PrimaryButton";
import { colors, spacing } from "@/shared/theme/theme";
import { driverTheme } from "@/shared/theme/driver-theme";

const FILTERS: DriverTripStatusFilter[] = ["ALL", ...DRIVER_TRIP_STATUSES];

export function DriverTripListScreen({ initialStatus = "ALL" }: { initialStatus?: DriverTripStatusFilter }) {
  const [status, setStatus] = useState(initialStatus);
  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <DriverTripHeader compact showBack title="Chuyến" />
      </View>
      <View style={styles.filterContainer}>
        <FlatList
          horizontal
          data={FILTERS}
          keyExtractor={(item) => item}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filters}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: status === item }}
              onPress={() => setStatus(item)}
              style={[styles.filter, status === item && styles.filterSelected]}
            >
              <Text
                style={[
                  styles.filterLabel,
                  status === item && styles.filterLabelSelected,
                ]}
              >
                {item === "ALL" ? "Tất cả" : driverTripStatusLabel(item)}
              </Text>
            </Pressable>
          )}
        />
      </View>

      <TripList key={status} status={status} onClearFilter={() => setStatus("ALL")} />
    </SafeAreaView>
  );
}

function TripList({ status, onClearFilter }: { status: DriverTripStatusFilter; onClearFilter(): void }) {
  const { isConnected, isInternetReachable } = useNetInfo();
  const online = isConnected === true && isInternetReachable !== false;
  const offline = isConnected === false || isInternetReachable === false;
  const {
    trips, error, loadMoreError, hasSnapshot, isInitialLoading, isRefreshing, isLoadingMore, hasMore,
    reload, refresh, loadMore,
  } = useDriverTrips(status);

  useFocusEffect(useCallback(() => {
    if (online) void reload();
  }, [online, reload]));

  const empty = () => {
    if (offline) return <Text style={styles.muted}>{hasSnapshot
      ? "Danh sách đã tải không có chuyến trong bộ lọc này."
      : "Chưa có dữ liệu chuyến đã tải cho bộ lọc này."}</Text>;
    if (isInitialLoading || isRefreshing || !online) return (
      <View style={styles.empty}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.muted}>{online ? "Đang tải chuyến…" : "Đang kiểm tra kết nối…"}</Text>
      </View>
    );
    if (error) return (
      <View style={styles.empty}>
        <ScreenMessage message={error} />
        <PrimaryButton label="Thử tải lại" variant="secondary" onPress={() => void reload()} />
      </View>
    );
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{status === "ALL"
          ? "Chưa có chuyến được phân công" : "Không có chuyến theo bộ lọc"}</Text>
        {status === "ALL" ? null : (
          <PrimaryButton label="Xem tất cả chuyến" variant="secondary" onPress={onClearFilter} />
        )}
      </View>
    );
  };

  return (
    <FlatList
      data={trips}
      keyExtractor={(item) => item.id}
      contentContainerStyle={[styles.list, trips.length === 0 && styles.emptyList]}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={() => { if (online) void refresh(); }}
          enabled={online}
          colors={[colors.primary]}
        />
      }
      renderItem={({ item }) => (
        <DriverTripCard trip={item} onPress={() => router.push({
          pathname: "/trips/[id]",
          params: { id: item.id },
        })} />
      )}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      onEndReached={() => {
        if (online && hasMore && !error && !loadMoreError) void loadMore();
      }}
      onEndReachedThreshold={0.35}
      ListHeaderComponent={
        offline ? (
          <Text style={styles.notice}>{hasSnapshot
            ? "Ngoại tuyến · Dữ liệu đã tải có thể đã cũ."
            : "Ngoại tuyến"}</Text>
        ) : error && trips.length > 0 ? (
          <View style={styles.message}>
            <ScreenMessage message={error} />
            <PrimaryButton label="Thử tải lại" variant="secondary" onPress={() => void refresh()} />
          </View>
        ) : undefined
      }
      ListEmptyComponent={empty()}
      ListFooterComponent={
        isLoadingMore ? (
          <ActivityIndicator accessibilityLabel="Đang tải thêm chuyến" color={colors.primary} />
        ) : loadMoreError ? (
          <View style={styles.message}>
            <ScreenMessage message={loadMoreError} />
            <PrimaryButton label="Thử tải thêm" variant="secondary" disabled={!online} onPress={() => void loadMore()} />
          </View>
        ) : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.md },
  filterContainer: { minHeight: 48 },
  filters: { paddingHorizontal: spacing.md, gap: spacing.xs, alignItems: "center" },
  filter: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minHeight: driverTheme.touchTarget,
    justifyContent: "center",
    borderRadius: driverTheme.radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterSelected: {
    backgroundColor: driverTheme.colors.infoSurface,
    borderColor: colors.primary,
  },
  filterLabel: { ...driverTheme.type.meta, color: colors.textMuted, fontWeight: "700" },
  filterLabelSelected: { color: driverTheme.colors.info },
  list: {
    padding: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  emptyList: { flexGrow: 1 },
  separator: { height: spacing.xs },
  message: { paddingVertical: spacing.sm, gap: spacing.xs },
  notice: { backgroundColor: driverTheme.colors.warningSurface, color: driverTheme.colors.warning,
    ...driverTheme.type.meta, padding: spacing.sm, borderRadius: driverTheme.radius.control, marginBottom: spacing.sm },
  empty: { flex: 1, justifyContent: "center", gap: spacing.sm },
  emptyTitle: {
    color: colors.text,
    ...driverTheme.type.heading,
    textAlign: "center",
  },
  muted: { ...driverTheme.type.meta, color: colors.textMuted, textAlign: "center" },
});
