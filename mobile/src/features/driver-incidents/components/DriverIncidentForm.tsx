import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type {
  CreateDriverIncidentInput,
  DriverIncidentOrderReference,
  DriverIncidentSeverity,
  DriverIncidentType,
} from '@/features/driver-incidents/types/driver-incident.types';
import {
  DRIVER_INCIDENT_SEVERITIES,
  DRIVER_INCIDENT_SEVERITY_LABELS,
  DRIVER_INCIDENT_TYPES,
  DRIVER_INCIDENT_TYPE_LABELS,
} from '@/features/driver-incidents/types/driver-incident.types';
import { validateDriverIncidentInput } from '@/features/driver-incidents/validation/driver-incident.validation';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';

interface Props {
  orders: DriverIncidentOrderReference[];
  isSubmitting: boolean;
  submitError: string | null;
  hasUncertainSubmission: boolean;
  canSubmit?: boolean;
  onSubmit(input: CreateDriverIncidentInput): Promise<boolean>;
  onClose(): void;
}

export function DriverIncidentForm({
  orders,
  isSubmitting,
  submitError,
  hasUncertainSubmission,
  canSubmit = true,
  onSubmit,
  onClose,
}: Props) {
  const occurredAt = useMemo(() => new Date().toISOString(), []);
  const [type, setType] = useState<DriverIncidentType>('VEHICLE_BREAKDOWN');
  const [severity, setSeverity] = useState<DriverIncidentSeverity>('MEDIUM');
  const [description, setDescription] = useState('');
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const toggleOrder = (id: string) => {
    setSelectedOrderIds((current) =>
      current.includes(id)
        ? current.filter((orderId) => orderId !== id)
        : [...current, id],
    );
  };

  const submit = async () => {
    if (!canSubmit) return;
    const input = {
      type,
      severity,
      description,
      occurredAt,
      affectedOrderIds: selectedOrderIds,
    };
    const validation = validateDriverIncidentInput(input);
    if (!validation.value) {
      setValidationError(
        Object.values(validation.errors)[0] ?? 'Dữ liệu sự cố không hợp lệ.',
      );
      return;
    }
    setValidationError(null);
    if (await onSubmit(validation.value)) onClose();
  };

  return (
    <Modal
      animationType="slide"
      transparent
      visible
      onRequestClose={() => {
        if (!isSubmitting) onClose();
      }}
    >
      <View style={styles.backdrop}>
        <View style={styles.modal}>
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.heading}>Báo sự cố</Text>
            <Text style={styles.label}>Loại sự cố</Text>
            <View style={styles.options}>
              {DRIVER_INCIDENT_TYPES.map((item) => (
                <Choice
                  key={item}
                  label={DRIVER_INCIDENT_TYPE_LABELS[item]}
                  selected={type === item}
                  onPress={() => setType(item)}
                />
              ))}
            </View>

            <Text style={styles.label}>Mức độ</Text>
            <View style={styles.options}>
              {DRIVER_INCIDENT_SEVERITIES.map((item) => (
                <Choice
                  key={item}
                  label={DRIVER_INCIDENT_SEVERITY_LABELS[item]}
                  selected={severity === item}
                  onPress={() => setSeverity(item)}
                />
              ))}
            </View>

            <Text style={styles.label}>Mô tả</Text>
            <TextInput
              accessibilityLabel="Mô tả sự cố"
              multiline
              maxLength={2000}
              value={description}
              onChangeText={setDescription}
              placeholder="Mô tả điều đã xảy ra (10–2000 ký tự)"
              style={styles.input}
              textAlignVertical="top"
            />
            <Text style={styles.counter}>{description.length}/2000</Text>

            <Text style={styles.label}>Thời điểm xảy ra</Text>
            <Text style={styles.info}>{formatDate(occurredAt)}</Text>
            <Text style={styles.hint}>
              MVP sử dụng thời điểm hiện tại khi mở biểu mẫu.
            </Text>

            <Text style={styles.label}>Đơn hàng bị ảnh hưởng (tùy chọn)</Text>
            {orders.length === 0 ? (
              <Text style={styles.hint}>
                Chuyến chưa có đơn hàng để lựa chọn.
              </Text>
            ) : (
              <View style={styles.options}>
                {orders.map((order) => (
                  <Choice
                    key={order.id}
                    label={order.orderNumber}
                    selected={selectedOrderIds.includes(order.id)}
                    onPress={() => toggleOrder(order.id)}
                  />
                ))}
              </View>
            )}

            {validationError ? (
              <ScreenMessage message={validationError} />
            ) : null}
            {submitError ? <ScreenMessage message={submitError} /> : null}
            {hasUncertainSubmission ? (
              <ScreenMessage message="Chưa xác định máy chủ đã nhận báo cáo hay chưa. Giữ nguyên nội dung và bấm gửi lại để dùng cùng mã chống trùng." />
            ) : null}
            <PrimaryButton
              label={hasUncertainSubmission ? 'Thử gửi lại' : 'Gửi báo cáo'}
              loading={isSubmitting}
              disabled={!canSubmit}
              onPress={() => void submit()}
            />
            <PrimaryButton
              label="Đóng"
              variant="secondary"
              disabled={isSubmitting}
              onPress={onClose}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceSelected]}
    >
      <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  modal: {
    maxHeight: '92%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
  },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl },
  heading: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  label: { color: colors.text, fontWeight: '800', marginTop: spacing.sm },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  choice: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
  },
  choiceSelected: { borderColor: colors.primary, backgroundColor: '#EAF1FF' },
  choiceText: { color: colors.textMuted, fontWeight: '600' },
  choiceTextSelected: { color: colors.primary },
  input: {
    minHeight: 110,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
    color: colors.text,
  },
  counter: { color: colors.textMuted, textAlign: 'right', fontSize: 12 },
  info: { color: colors.text, fontWeight: '600' },
  hint: { color: colors.textMuted, lineHeight: 19 },
});
