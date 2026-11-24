import { useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { startActivityAsync } from 'expo-intent-launcher';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';
import { normalizeDriverStopPhone } from '../selectors/driver-stop-contact';

export function DriverStopContact({ name, phone, allowPhone }: {
  name: string | null;
  phone: string | null;
  allowPhone: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const [dialerError, setDialerError] = useState(false);
  const openingRef = useRef(false);
  const dialNumber = allowPhone ? normalizeDriverStopPhone(phone) : null;
  const canDial = Platform.OS === 'android' && dialNumber !== null;

  async function openDialer() {
    if (!canDial || !dialNumber || openingRef.current) return;
    openingRef.current = true;
    setDialerError(false);
    setOpening(true);
    try {
      await startActivityAsync('android.intent.action.DIAL', { data: `tel:${dialNumber}` });
    } catch {
      setDialerError(true);
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Liên hệ tại điểm dừng</Text>
      {name?.trim() ? <Text style={styles.text}>{name}</Text> : null}
      {dialNumber ? <Text style={styles.text}>{dialNumber}</Text> : (
        <Text style={styles.meta}>{allowPhone ? 'Chưa có số điện thoại hợp lệ.' : 'Chỉ xem thông tin điểm dừng.'}</Text>
      )}
      {canDial ? (
        <>
          <PrimaryButton appearance="driver" variant="secondary" label="Gọi điện"
            loading={opening} onPress={() => void openDialer()} />
          {dialerError ? <ScreenMessage message="Không thể mở trình quay số trên thiết bị này." /> : null}
        </>
      ) : null}
    </View>
  );
}

const { colors, spacing, type } = driverTheme;
const styles = StyleSheet.create({
  container: { gap: spacing.xs, paddingVertical: spacing.xs },
  label: { ...type.strong, color: colors.text },
  text: { ...type.body, color: colors.text },
  meta: { ...type.meta, color: colors.textMuted },
});
