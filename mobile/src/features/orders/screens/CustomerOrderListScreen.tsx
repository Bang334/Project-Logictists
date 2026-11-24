import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { OrderCard } from '@/features/orders/components/OrderCard';
import { OrderScreenHeader } from '@/features/orders/components/OrderScreenHeader';
import { orderStatusLabel } from '@/features/orders/components/OrderStatusBadge';
import { useCustomerOrders } from '@/features/orders/hooks/useCustomerOrders';
import {
  ORDER_STATUSES,
  type OrderStatusFilter,
} from '@/features/orders/types/order.types';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';

const FILTERS: OrderStatusFilter[] = ['ALL', ...ORDER_STATUSES];

export function CustomerOrderListScreen() {
  const [status, setStatus] = useState<OrderStatusFilter>('ALL');
  const {
    orders,
    error,
    isInitialLoading,
    isRefreshing,
    isLoadingMore,
    hasMore,
    reload,
    refresh,
    loadMore,
  } = useCustomerOrders(status);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <OrderScreenHeader
        title="Đơn vận chuyển"
        subtitle="Theo dõi các yêu cầu bạn đã tạo"
        showBack
        actionLabel="Tạo đơn"
        onAction={() => router.push('/orders/create')}
      />
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
              style={[
                styles.filter,
                status === item && styles.filterSelected,
              ]}
            >
              <Text
                style={[
                  styles.filterLabel,
                  status === item && styles.filterLabelSelected,
                ]}
              >
                {item === 'ALL' ? 'Tất cả' : orderStatusLabel(item)}
              </Text>
            </Pressable>
          )}
        />
      </View>

      {isInitialLoading && orders.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.muted}>Đang tải danh sách đơn...</Text>
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.list,
            orders.length === 0 && styles.emptyList,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => void refresh()}
              colors={[colors.primary]}
            />
          }
          renderItem={({ item }) => (
            <OrderCard
              order={item}
              onPress={() =>
                router.push({
                  pathname: '/orders/[id]',
                  params: { id: item.id },
                })
              }
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          onEndReached={() => {
            if (hasMore) void loadMore();
          }}
          onEndReachedThreshold={0.35}
          ListHeaderComponent={
            error ? <ScreenMessage message={error} /> : <View />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Chưa có đơn vận chuyển</Text>
              <Text style={styles.muted}>
                Tạo yêu cầu đầu tiên để nhân viên kiểm tra và điều phối.
              </Text>
              <PrimaryButton
                label="Tạo đơn mới"
                onPress={() => router.push('/orders/create')}
              />
            </View>
          }
          ListFooterComponent={
            isLoadingMore ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <View />
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  filterContainer: { minHeight: 48 },
  filters: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  filter: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterLabel: { color: colors.textMuted, fontWeight: '700' },
  filterLabelSelected: { color: colors.surface },
  list: { padding: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xl },
  emptyList: { flexGrow: 1 },
  separator: { height: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  empty: { flex: 1, justifyContent: 'center', gap: spacing.md },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  muted: { color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
