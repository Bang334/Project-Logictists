import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/shared/theme/theme';

interface ScreenMessageProps {
  message: string;
  tone?: 'error' | 'success';
}

export function ScreenMessage({ message, tone = 'error' }: ScreenMessageProps) {
  return (
    <View
      accessibilityRole="alert"
      style={[styles.container, tone === 'success' && styles.successContainer]}
    >
      <Text style={[styles.text, tone === 'success' && styles.successText]}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
    borderRadius: 10,
    backgroundColor: colors.dangerSurface,
  },
  successContainer: { backgroundColor: colors.successSurface },
  text: { color: colors.danger, lineHeight: 20 },
  successText: { color: colors.success },
});
