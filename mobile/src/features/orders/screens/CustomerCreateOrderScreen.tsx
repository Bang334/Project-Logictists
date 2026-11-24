import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Crypto from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { OrderFormField } from '@/features/orders/components/OrderFormField';
import { OrderScreenHeader } from '@/features/orders/components/OrderScreenHeader';
import { PackageItemEditor } from '@/features/orders/components/PackageItemEditor';
import { useCreateCustomerOrder } from '@/features/orders/hooks/useCreateCustomerOrder';
import { useCustomerBranches } from '@/features/orders/hooks/useCustomerBranches';
import type {
  CreateOrderFormErrors,
  CreateOrderFormValues,
  OrderItemFormValues,
  OrderStopFormValues,
  PackageType,
} from '@/features/orders/types/order.types';
import { validateCreateOrder } from '@/features/orders/validation/order.validation';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';

const emptyStop = (): OrderStopFormValues => ({
  address: '',
  latitude: '',
  longitude: '',
  contactName: '',
  contactPhone: '',
});

const emptyItem = (): OrderItemFormValues => ({
  clientId: Crypto.randomUUID(),
  description: '',
  packageType: 'CARTON',
  quantity: '1',
  unitWeightKg: '',
  lengthCm: '',
  widthCm: '',
  heightCm: '',
});

const initialForm = (): CreateOrderFormValues => ({
  branchId: '',
  pickup: emptyStop(),
  delivery: emptyStop(),
  items: [emptyItem()],
  notes: '',
});

export function CustomerCreateOrderScreen() {
  const [values, setValues] = useState(initialForm);
  const [errors, setErrors] = useState<CreateOrderFormErrors>({});
  const { branches, isLoading: isLoadingBranches, error: branchError, reload } =
    useCustomerBranches();
  const {
    submit,
    isSubmitting,
    error,
    hasUncertainSubmission,
    clearError,
  } = useCreateCustomerOrder();

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const clearFieldError = (path: string) => {
    setErrors((current) => {
      if (!current[path]) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    clearError();
  };

  const setStopField = (
    type: 'pickup' | 'delivery',
    field: keyof OrderStopFormValues,
    value: string,
  ) => {
    setValues((current) => ({
      ...current,
      [type]: { ...current[type], [field]: value },
    }));
    clearFieldError(`${type}.${field}`);
  };

  const setItemField = (
    index: number,
    field: keyof OrderItemFormValues,
    value: string,
  ) => {
    setValues((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    }));
    clearFieldError(`items.${index}.${field}`);
  };

  const setPackageType = (index: number, packageType: PackageType) => {
    setValues((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, packageType } : item,
      ),
    }));
  };

  const removeItem = (index: number) => {
    setValues((current) => ({
      ...current,
      items: current.items.filter((_, itemIndex) => itemIndex !== index),
    }));
    setErrors({});
    clearError();
  };

  const addItem = () => {
    if (values.items.length >= 20) {
      setErrors((current) => ({
        ...current,
        items: 'Mỗi đơn chỉ được có tối đa 20 loại kiện.',
      }));
      return;
    }
    setValues((current) => ({ ...current, items: [...current.items, emptyItem()] }));
    clearFieldError('items');
  };

  const submitForm = async () => {
    const validation = validateCreateOrder(values);
    if (!validation.success) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    try {
      const created = await submit(validation.data);
      if (!created) return;
      Alert.alert(
        'Đã tạo yêu cầu',
        `${created.orderNumber} đang ở trạng thái chờ duyệt.`,
        [
          {
            text: 'Xem chi tiết',
            onPress: () =>
              router.replace({
                pathname: '/orders/[id]',
                params: { id: created.id },
              }),
          },
        ],
      );
    } catch {
      // Hook preserves the idempotency key when the result is uncertain.
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <OrderScreenHeader title="Tạo đơn vận chuyển" showBack />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          {error ? <ScreenMessage message={error} /> : null}
          {hasUncertainSubmission ? (
            <ScreenMessage
              message="Chưa xác định máy chủ đã nhận đơn hay chưa. Giữ nguyên nội dung và bấm gửi lại để dùng cùng mã chống trùng. Nếu sửa nội dung, ứng dụng sẽ tạo mã mới."
            />
          ) : null}

          <FormSection title="Chi nhánh tiếp nhận">
            {isLoadingBranches ? (
              <ActivityIndicator color={colors.primary} />
            ) : branchError ? (
              <View style={styles.gap}>
                <ScreenMessage message={branchError} />
                <PrimaryButton
                  label="Tải lại chi nhánh"
                  variant="secondary"
                  onPress={() => void reload()}
                />
              </View>
            ) : branches.length === 0 ? (
              <ScreenMessage message="Hiện không có chi nhánh hoạt động để nhận đơn." />
            ) : (
              <View style={styles.branchList}>
                {branches.map((branch) => (
                  <Pressable
                    key={branch.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: values.branchId === branch.id }}
                    onPress={() => {
                      setValues((current) => ({ ...current, branchId: branch.id }));
                      clearFieldError('branchId');
                    }}
                    style={[
                      styles.branch,
                      values.branchId === branch.id && styles.branchSelected,
                    ]}
                  >
                    <Text style={styles.branchCode}>{branch.code}</Text>
                    <Text style={styles.branchName}>{branch.name}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {errors.branchId ? <Text style={styles.error}>{errors.branchId}</Text> : null}
            <Text style={styles.helper}>
              Chi nhánh sẽ kiểm tra phạm vi phục vụ trước khi duyệt đơn.
            </Text>
          </FormSection>

          <StopSection
            title="Điểm lấy hàng"
            prefix="pickup"
            values={values.pickup}
            errors={errors}
            onChange={(field, value) => setStopField('pickup', field, value)}
          />
          <StopSection
            title="Điểm giao hàng"
            prefix="delivery"
            values={values.delivery}
            errors={errors}
            onChange={(field, value) => setStopField('delivery', field, value)}
          />

          <FormSection title={`Hàng hóa (${values.items.length}/20 loại)`}>
            {values.items.map((item, index) => (
              <PackageItemEditor
                key={item.clientId}
                item={item}
                index={index}
                errors={errors}
                canRemove={values.items.length > 1}
                onChange={(field, value) => setItemField(index, field, value)}
                onPackageTypeChange={(type) => setPackageType(index, type)}
                onRemove={() => removeItem(index)}
              />
            ))}
            {errors.items ? <Text style={styles.error}>{errors.items}</Text> : null}
            <PrimaryButton
              label="Thêm loại kiện"
              variant="secondary"
              disabled={values.items.length >= 20}
              onPress={addItem}
            />
          </FormSection>

          <FormSection title="Ghi chú">
            <OrderFormField
              label="Thông tin bổ sung (không bắt buộc)"
              value={values.notes}
              onChangeText={(notes) => {
                setValues((current) => ({ ...current, notes }));
                clearFieldError('notes');
              }}
              multiline
              error={errors.notes}
            />
          </FormSection>

          <Text style={styles.notice}>
            Đơn mới được lưu ở trạng thái chờ duyệt. Ứng dụng không hiển thị giá vì hệ thống chưa báo giá vận chuyển.
          </Text>
          <PrimaryButton
            label={hasUncertainSubmission ? 'Gửi lại cùng yêu cầu' : 'Tạo đơn DRAFT'}
            loading={isSubmitting}
            disabled={branches.length === 0}
            onPress={() => void submitForm()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function StopSection({
  title,
  prefix,
  values,
  errors,
  onChange,
}: {
  title: string;
  prefix: 'pickup' | 'delivery';
  values: OrderStopFormValues;
  errors: CreateOrderFormErrors;
  onChange: (field: keyof OrderStopFormValues, value: string) => void;
}) {
  return (
    <FormSection title={title}>
      <OrderFormField
        label="Địa chỉ"
        value={values.address}
        onChangeText={(value) => onChange('address', value)}
        error={errors[`${prefix}.address`]}
      />
      <View style={styles.twoColumns}>
        <View style={styles.column}>
          <OrderFormField
            label="Vĩ độ"
            value={values.latitude}
            onChangeText={(value) => onChange('latitude', value)}
            keyboardType="numbers-and-punctuation"
            error={errors[`${prefix}.latitude`]}
          />
        </View>
        <View style={styles.column}>
          <OrderFormField
            label="Kinh độ"
            value={values.longitude}
            onChangeText={(value) => onChange('longitude', value)}
            keyboardType="numbers-and-punctuation"
            error={errors[`${prefix}.longitude`]}
          />
        </View>
      </View>
      <Text style={styles.helper}>
        Chưa tích hợp bản đồ/geocoding; nhập tọa độ thực tế theo định dạng số thập phân.
      </Text>
      <OrderFormField
        label="Người liên hệ"
        value={values.contactName}
        onChangeText={(value) => onChange('contactName', value)}
        error={errors[`${prefix}.contactName`]}
      />
      <OrderFormField
        label="Số điện thoại"
        value={values.contactPhone}
        onChangeText={(value) => onChange('contactPhone', value)}
        keyboardType="phone-pad"
        error={errors[`${prefix}.contactPhone`]}
      />
    </FormSection>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingTop: 0, gap: spacing.md, paddingBottom: spacing.xl },
  section: { backgroundColor: colors.surface, borderRadius: 18, padding: spacing.lg, gap: spacing.md },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  branchList: { gap: spacing.sm },
  branch: { padding: spacing.md, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  branchSelected: { borderColor: colors.primary, backgroundColor: '#E8F0FE' },
  branchCode: { color: colors.primary, fontWeight: '800' },
  branchName: { color: colors.text, marginTop: 3 },
  twoColumns: { flexDirection: 'row', gap: spacing.sm },
  column: { flex: 1 },
  helper: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13 },
  notice: { color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  gap: { gap: spacing.md },
});
