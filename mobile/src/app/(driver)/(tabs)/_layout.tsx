import { Tabs } from 'expo-router';
import { Image, StyleSheet, Text, useWindowDimensions, type ColorValue, type ImageSourcePropType } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { driverTheme } from '@/shared/theme/driver-theme';

const { colors } = driverTheme;

function tab(title: string, icon: ImageSourcePropType, id: string) {
  return {
    title,
    tabBarAccessibilityLabel: title,
    tabBarButtonTestID: id,
    tabBarIcon: ({ color }: { color: ColorValue | null }) => (
      <Image source={icon} accessible={false} style={[styles.icon, { tintColor: color }]} />
    ),
    tabBarLabel: ({ color }: { color: ColorValue | null }) => (
      <Text style={[styles.label, { color: color ?? colors.textMuted }]}>{title}</Text>
    ),
  };
}

export default function DriverTabsLayout() {
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();

  return (
    <Tabs backBehavior="firstRoute" screenOptions={{
      headerShown: false,
      tabBarLabelPosition: 'below-icon',
      tabBarActiveTintColor: colors.primary,
      tabBarInactiveTintColor: colors.textMuted,
      tabBarStyle: { ...styles.bar, height: Math.max(60, 32 + Math.ceil(28 * fontScale)) + bottom },
    }}>
      <Tabs.Screen name="index" options={tab('Trang chủ', require('@/shared/assets/driver-tabs/home.png'), 'driver-tab-home')} />
      <Tabs.Screen name="calendar" options={tab('Lịch chuyến', require('@/shared/assets/driver-tabs/calendar.png'), 'driver-tab-calendar')} />
      <Tabs.Screen name="activity" options={tab('Hoạt động', require('@/shared/assets/driver-tabs/activity.png'), 'driver-tab-activity')} />
      <Tabs.Screen name="account" options={tab('Tài khoản', require('@/shared/assets/driver-tabs/account.png'), 'driver-tab-account')} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.surface, borderTopColor: colors.border },
  icon: { width: 24, height: 24 },
  label: { fontSize: 11, lineHeight: 14, fontWeight: '600', textAlign: 'center', paddingHorizontal: 2 },
});
