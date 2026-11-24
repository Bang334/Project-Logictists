import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  PACKAGE_TYPES,
  type OrderItemFormValues,
  type PackageType,
} from '@/features/orders/types/order.types';
import { colors, spacing } from '@/shared/theme/theme';
import { OrderFormField } from './OrderFormField';

interface PackageItemEditorProps {
  item: OrderItemFormValues;
  index: number;
  errors: Record<string, string>;
  canRemove: boolean;
  onChange: (field: keyof OrderItemFormValues, value: string) => void;
  onPackageTypeChange: (value: PackageType) => void;
  onRemove: () => void;
}

export function PackageItemEditor({
  item,
  index,
  errors,
  canRemove,
  onChange,
  onPackageTypeChange,
  onRemove,
}: PackageItemEditorProps) {
  const path = (field: string) => errors[`items.${index}.${field}`];
  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        <Text style={styles.title}>Loại kiện {index + 1}</Text>
        {canRemove ? (
          <Pressable accessibilityRole="button" onPress={onRemove}>
            <Text style={styles.remove}>Xóa</Text>
          </Pressable>
        ) : null}
      </View>
      <OrderFormField
        label="Tên hàng/kiện"
        value={item.description}
        onChangeText={(value) => onChange('description', value)}
        error={path('description')}
      />
      <View style={styles.typeRow}>
        {PACKAGE_TYPES.map((type) => (
          <Pressable
            key={type}
            accessibilityRole="button"
            accessibilityState={{ selected: item.packageType === type }}
            onPress={() => onPackageTypeChange(type)}
            style={[
              styles.typeButton,
              item.packageType === type && styles.typeButtonSelected,
            ]}
          >
            <Text
              style={[
                styles.typeLabel,
                item.packageType === type && styles.typeLabelSelected,
              ]}
            >
              {type}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.twoColumns}>
        <View style={styles.column}>
          <OrderFormField
            label="Số lượng"
            value={item.quantity}
            onChangeText={(value) => onChange('quantity', value)}
            keyboardType="number-pad"
            error={path('quantity')}
          />
        </View>
        <View style={styles.column}>
          <OrderFormField
            label="Kg mỗi kiện"
            value={item.unitWeightKg}
            onChangeText={(value) => onChange('unitWeightKg', value)}
            keyboardType="decimal-pad"
            error={path('unitWeightKg')}
          />
        </View>
      </View>
      <View style={styles.dimensions}>
        {(['lengthCm', 'widthCm', 'heightCm'] as const).map((field) => (
          <View key={field} style={styles.dimensionColumn}>
            <OrderFormField
              label={
                field === 'lengthCm'
                  ? 'Dài (cm)'
                  : field === 'widthCm'
                    ? 'Rộng (cm)'
                    : 'Cao (cm)'
              }
              value={item[field]}
              onChangeText={(value) => onChange(field, value)}
              keyboardType="decimal-pad"
              error={path(field)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 16,
    backgroundColor: '#F8FAFD',
    borderWidth: 1,
    borderColor: colors.border,
  },
  heading: { flexDirection: 'row', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  remove: { color: colors.danger, fontWeight: '700' },
  typeRow: { flexDirection: 'row', gap: spacing.sm },
  typeButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  typeButtonSelected: { borderColor: colors.primary, backgroundColor: '#E8F0FE' },
  typeLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '800' },
  typeLabelSelected: { color: colors.primary },
  twoColumns: { flexDirection: 'row', gap: spacing.sm },
  column: { flex: 1 },
  dimensions: { flexDirection: 'row', gap: spacing.xs },
  dimensionColumn: { flex: 1 },
});
