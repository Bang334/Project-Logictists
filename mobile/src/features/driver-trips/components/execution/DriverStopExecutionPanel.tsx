import { useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type {
  DriverDeliveryResult,
  DriverExecutionReasonCode,
  DriverStopTask,
  DriverTripStop,
} from '@/features/driver-trips/types/driver-trip.types';
import {
  createStopExecutionForm,
  inferDeliveryResult,
  type StopCompletionData,
  type DriverStopExecutionForm,
  validateStopCompletion,
} from '@/features/driver-trips/validation/driver-trip-execution.validation';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { driverTheme } from '@/shared/theme/driver-theme';
import { driverPackageStatusLabel, driverTaskActionLabel } from '../DriverTripStatusBadge';

const { colors, spacing } = driverTheme;

const REASONS: {
  code: DriverExecutionReasonCode;
  label: string;
}[] = [
  { code: 'PACKAGE_NOT_AVAILABLE', label: 'Không có kiện hàng' },
  { code: 'PACKAGE_DAMAGED', label: 'Kiện bị hư hỏng' },
  { code: 'QUANTITY_MISMATCH', label: 'Sai số lượng' },
  { code: 'RECIPIENT_UNAVAILABLE', label: 'Không gặp người nhận' },
  { code: 'RECIPIENT_REFUSED', label: 'Người nhận từ chối' },
  { code: 'ADDRESS_ISSUE', label: 'Sai/khó tìm địa chỉ' },
  { code: 'ACCESS_RESTRICTED', label: 'Không thể tiếp cận' },
  { code: 'OTHER', label: 'Khác' },
];

interface Props {
  stop: DriverTripStop;
  isSubmitting: boolean;
  onSubmit: (data: StopCompletionData) => Promise<boolean>;
  draft?: DriverStopExecutionForm | null;
  onDraftChange?: (draft: DriverStopExecutionForm) => void;
  renderLayout?: (fields: ReactNode, action: ReactNode) => ReactNode;
  onRevealError?: (element: ComponentRef<typeof View>) => void;
}

type FieldError = { field: string | null; message: string };

// The validator stays authoritative. Use its first failure to locate the matching input.
function locateError(stop: DriverTripStop, form: DriverStopExecutionForm, message: string): FieldError {
  let field: string | null = null;
  if (message.startsWith('Số lượng thực tế')) {
    const invalidTask = stop.tasks.find((task) => {
      const result = validateStopCompletion({ ...stop, tasks: [task] }, form);
      return !result.success && result.message === message;
    });
    field = invalidTask ? `quantity:${invalidTask.id}` : null;
  } else if (message.startsWith('Vui lòng chọn lý do')) field = 'reason';
  else if (message.startsWith('Vui lòng nhập ghi chú')) field = 'note';
  else if (message.startsWith('Vui lòng nhập tên người nhận')) field = 'recipient';
  return { field, message };
}

export function DriverStopExecutionPanel({
  stop,
  isSubmitting,
  onSubmit,
  draft,
  onDraftChange,
  renderLayout,
  onRevealError,
}: Props) {
  const [internalForm, setInternalForm] = useState(() => createStopExecutionForm(stop));
  const form = draft ?? internalForm;
  const setForm = (update: (current: DriverStopExecutionForm) => DriverStopExecutionForm) => {
    if (onDraftChange) onDraftChange(update(form));
    else setInternalForm(update);
  };
  const [validationError, setValidationError] = useState<FieldError | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const needsReason = stop.tasks.some((task) =>
    Number(form.quantities[task.id]) < task.plannedQuantity,
  );
  const detailsVisible = showDetails || needsReason || form.reasonCode !== null || form.note !== '';

  const deliveryResult = useMemo(
    () => inferDeliveryResult(stop, form.quantities),
    [form.quantities, stop],
  );
  const isDepot =
    stop.stopType === 'DEPOT_START' || stop.stopType === 'DEPOT_END';

  const submit = async () => {
    const validation = validateStopCompletion(stop, form);
    if (!validation.success) {
      setValidationError(locateError(stop, form, validation.message));
      return;
    }
    setValidationError(null);
    await onSubmit(validation.data);
  };

  const showError = (field: string | null) => validationError?.field === field
    ? <InlineError message={validationError.message} onReveal={onRevealError} /> : null;
  const action = (
    <PrimaryButton appearance="driver" label={isDepot ? 'Hoàn thành điểm kho' : actionLabel(stop, deliveryResult)}
      loading={isSubmitting} onPress={() => void submit()} />
  );
  const fields = isDepot ? (
      <View style={styles.panel} testID={`driver-stop-execution-${stop.id}`}>
        <Text style={styles.helper}>Xác nhận hoàn thành sau khi đã đến kho.</Text>
        {showError(null)}
      </View>
  ) : (
    <View style={styles.panel} testID={`driver-stop-execution-${stop.id}`}>
      <Text style={styles.title}>
        {stop.stopType === 'PICKUP'
          ? 'Xác nhận lấy hàng thực tế'
          : 'Xác nhận giao hàng thực tế'}
      </Text>
      {stop.tasks.map((task) => (
        <TaskQuantityInput
          key={task.id}
          task={task}
          value={form.quantities[task.id] ?? ''}
          disabled={isSubmitting}
          error={showError(`quantity:${task.id}`)}
          onChange={(value) => {
            setForm((current) => ({
              ...current,
              quantities: { ...current.quantities, [task.id]: value },
            }));
            setValidationError(null);
          }}
        />
      ))}

      {stop.stopType === 'DELIVERY' && deliveryResult ? (
        <View
          style={[
            styles.result,
            deliveryResult === 'FAILED' && styles.failedResult,
            deliveryResult === 'PARTIAL' && styles.partialResult,
          ]}
        >
          <Text style={styles.resultText}>
            Kết quả: {deliveryResultLabel(deliveryResult)}
          </Text>
          {deliveryResult === 'FAILED' ? (
            <Text style={styles.warning}>
              Lần giao này thất bại. Kiện hàng chưa được coi là đã giao; bạn vẫn
              có thể tiếp tục chuyến sau khi máy chủ xác nhận điểm dừng.
            </Text>
          ) : null}
        </View>
      ) : null}

      {stop.stopType === 'DELIVERY' ? (
        <View style={styles.inputGroup}>
          <LabeledInput
            label="Người nhận (bắt buộc khi có hàng được giao)"
            value={form.recipientName}
            editable={!isSubmitting}
            onChangeText={(recipientName) => {
              setForm((current) => ({ ...current, recipientName }));
              setValidationError(null);
            }}
          />
          {showError('recipient')}
        </View>
      ) : null}
      {detailsVisible ? (
        <>
          <Text style={styles.fieldLabel}>Lý do khi thiếu/thất bại</Text>
          <View style={styles.reasonList}>
            {REASONS.map((reason) => (
              <Pressable
                key={reason.code}
                accessibilityRole="button"
                accessibilityState={{ selected: form.reasonCode === reason.code }}
                disabled={isSubmitting}
                onPress={() => {
                  setForm((current) => ({ ...current, reasonCode: reason.code }));
                  setValidationError(null);
                }}
                style={[
                  styles.reason,
                  form.reasonCode === reason.code && styles.reasonSelected,
                ]}
              >
                <Text
                  style={[
                    styles.reasonText,
                    form.reasonCode === reason.code && styles.reasonTextSelected,
                  ]}
                >
                  {reason.label}
                </Text>
              </Pressable>
            ))}
          </View>
          {showError('reason')}
          <LabeledInput
            label={
              form.reasonCode === 'OTHER'
                ? 'Ghi chú (bắt buộc khi chọn Khác)'
                : 'Ghi chú (không bắt buộc)'
            }
            value={form.note}
            editable={!isSubmitting}
            multiline
            onChangeText={(note) => {
              setForm((current) => ({ ...current, note }));
              setValidationError(null);
            }}
          />
          {showError('note')}
        </>
      ) : (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: false }}
          style={styles.detailsLink} onPress={() => setShowDetails(true)}>
          <Text style={styles.title}>Lý do và ghi chú</Text>
        </Pressable>
      )}

      {showError(null)}
    </View>
  );
  return renderLayout ? renderLayout(fields, action) : <View style={styles.standalone}>{fields}{action}</View>;
}

function InlineError({ message, onReveal }: {
  message: string;
  onReveal?: (element: ComponentRef<typeof View>) => void;
}) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  return (
    <View ref={ref} collapsable={false} onLayout={() => { if (ref.current) onReveal?.(ref.current); }}>
      <Text accessibilityRole="alert" style={styles.error}>{message}</Text>
    </View>
  );
}

function TaskIdentity({ task }: { task: DriverStopTask }) {
  return (
    <>
      <Text style={styles.taskName}>{task.package?.packageCode ?? task.order?.orderNumber ?? task.id}</Text>
      <Text style={styles.helper}>{driverTaskActionLabel(task.action)}{task.order && task.package ? ` · ${task.order.orderNumber}` : ''}</Text>
    </>
  );
}

const weightFormat = new Intl.NumberFormat('vi-VN');

function TaskPackageDetails({ item }: { item: NonNullable<DriverStopTask['package']> }) {
  return (
    <View style={styles.quantityRow}>
      <Text style={styles.helper}>{driverPackageStatusLabel(item.status)} · {weightFormat.format(item.weightKg)} kg</Text>
      <Text style={styles.helper}>{item.lengthCm} × {item.widthCm} × {item.heightCm} cm</Text>
    </View>
  );
}

export function DriverStopTaskSummary({ tasks }: { tasks: DriverStopTask[] }) {
  if (!tasks.length) return null;
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Công việc · {tasks.length}</Text>
      {tasks.map((task) => (
        <View key={task.id} style={styles.taskInput}>
          <TaskIdentity task={task} />
          <Text style={styles.helper}>Kế hoạch: {task.plannedQuantity}
            {task.actualQuantity !== null ? ` · Thực tế: ${task.actualQuantity}` : ''}
          </Text>
          {task.package ? <TaskPackageDetails item={task.package} /> : null}
        </View>
      ))}
    </View>
  );
}

function TaskQuantityInput({
  task,
  value,
  disabled,
  onChange,
  error,
}: {
  task: DriverStopTask;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  error: ReactNode;
}) {
  return (
    <View style={styles.taskInput} testID={`stop-task-input-${task.id}`}>
      <TaskIdentity task={task} />
      {task.package ? <TaskPackageDetails item={task.package} /> : null}
      <View style={styles.quantityRow}>
        <Text style={styles.fieldLabel}>Kế hoạch: {task.plannedQuantity}</Text>
        {task.plannedQuantity === 1 ? (
          <View style={styles.binaryActions}>
            {[
              { value: '1', label: 'Đã xử lý: 1' },
              { value: '0', label: 'Không xử lý được: 0' },
            ].map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: value === option.value }}
                disabled={disabled}
                onPress={() => onChange(option.value)}
                style={[
                  styles.binaryButton,
                  value === option.value && styles.binarySelected,
                ]}
              >
                <Text
                  style={[
                    styles.binaryText,
                    value === option.value && styles.binaryTextSelected,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <View style={styles.quantityField}>
          <Text style={styles.helper}>Thực tế</Text>
          <TextInput
            accessibilityLabel={`Số lượng thực tế ${task.id}`}
            editable={!disabled}
            keyboardType="number-pad"
            value={value}
            onChangeText={onChange}
            style={styles.input}
          />
          </View>
        )}
      </View>
      {error}
    </View>
  );
}

function LabeledInput({
  label,
  ...props
}: React.ComponentProps<typeof TextInput> & { label: string }) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        {...props}
        style={[styles.input, props.multiline && styles.multiline]}
      />
    </View>
  );
}

function deliveryResultLabel(result: DriverDeliveryResult) {
  if (result === 'SUCCESS') return 'Giao thành công';
  if (result === 'PARTIAL') return 'Giao một phần';
  return 'Giao thất bại';
}

function actionLabel(
  stop: DriverTripStop,
  deliveryResult: DriverDeliveryResult | null,
) {
  if (stop.stopType === 'PICKUP') return 'Hoàn thành lấy hàng';
  if (deliveryResult === 'FAILED') return 'Xác nhận giao thất bại';
  if (deliveryResult === 'SUCCESS') return 'Giao thành công';
  return 'Hoàn thành giao hàng';
}

const styles = StyleSheet.create({
  standalone: { gap: spacing.sm },
  panel: {
    padding: spacing.md,
    borderRadius: driverTheme.radius.card,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  title: { ...driverTheme.type.heading, color: colors.text },
  detailsLink: { minHeight: 48, justifyContent: 'center' },
  helper: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  taskInput: {
    padding: spacing.sm,
    borderRadius: driverTheme.radius.control,
    backgroundColor: colors.background,
    gap: spacing.xs,
  },
  taskName: { ...driverTheme.type.strong, color: colors.text },
  quantityRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  quantityField: { flexGrow: 1, minWidth: 96, gap: spacing.xs },
  binaryActions: { flexGrow: 1, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  binaryButton: {
    flexGrow: 1,
    minHeight: driverTheme.touchTarget,
    padding: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  binarySelected: { borderColor: colors.primary, backgroundColor: colors.infoSurface },
  binaryText: { color: colors.textMuted, textAlign: 'center', fontWeight: '600' },
  binaryTextSelected: { color: colors.primary },
  fieldLabel: { color: colors.text, fontWeight: '700' },
  reasonList: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  reason: {
    minHeight: driverTheme.touchTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reasonSelected: { borderColor: colors.primary, backgroundColor: colors.infoSurface },
  reasonText: { color: colors.textMuted, fontSize: 13 },
  reasonTextSelected: { color: colors.primary, fontWeight: '700' },
  inputGroup: { gap: spacing.xs },
  input: {
    minHeight: driverTheme.touchTarget,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    color: colors.text,
  },
  multiline: { minHeight: 86, paddingTop: spacing.sm, textAlignVertical: 'top' },
  result: {
    padding: spacing.sm,
    borderRadius: 10,
    backgroundColor: colors.successSurface,
  },
  failedResult: { backgroundColor: colors.dangerSurface },
  partialResult: { backgroundColor: driverTheme.colors.warningSurface },
  resultText: { color: colors.text, fontWeight: '800' },
  warning: { marginTop: spacing.xs, color: colors.danger, lineHeight: 19 },
  error: { color: colors.danger, lineHeight: 19 },
});
