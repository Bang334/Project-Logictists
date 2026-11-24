import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors, spacing } from '@/shared/theme/theme';
import { driverTheme } from '@/shared/theme/driver-theme';

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary';
  appearance?: 'default' | 'driver';
}

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  variant = 'primary',
  appearance = 'default',
}: PrimaryButtonProps) {
  const isDisabled = disabled || loading;
  const driver = appearance === 'driver';
  const secondary = variant === 'secondary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        driver && (secondary ? styles.driverSecondary : styles.driverPrimary),
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={secondary ? (driver ? driverTheme.colors.primary : colors.primary) : colors.surface}
        />
      ) : (
        <Text
          style={[
            styles.label,
            secondary && styles.secondaryLabel,
            driver && driverTheme.type.strong,
            driver && secondary && styles.driverSecondaryLabel,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.primary,
  },
  secondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.55 },
  label: { color: colors.surface, fontSize: 16, fontWeight: '700' },
  secondaryLabel: { color: colors.primary },
  driverPrimary: {
    minHeight: driverTheme.actionHeight,
    backgroundColor: driverTheme.colors.primary,
    borderRadius: driverTheme.radius.control,
  },
  driverSecondary: {
    minHeight: driverTheme.actionHeight,
    borderColor: driverTheme.colors.border,
    borderRadius: driverTheme.radius.control,
  },
  driverSecondaryLabel: { color: driverTheme.colors.primary },
});
