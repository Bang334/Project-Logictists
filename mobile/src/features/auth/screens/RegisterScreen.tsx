import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';
import { Link, router } from 'expo-router';
import { AuthScreenLayout } from '@/features/auth/components/AuthScreenLayout';
import { FormField } from '@/features/auth/components/FormField';
import { useRegisterCustomer } from '@/features/auth/hooks/useRegisterCustomer';
import type {
  FieldErrors,
  RegisterFormValues,
} from '@/features/auth/types/auth.types';
import { validateRegistration } from '@/features/auth/validation/auth.validation';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';

const initialValues: RegisterFormValues = {
  username: '',
  password: '',
  confirmPassword: '',
  fullName: '',
  phone: '',
  email: '',
};

export function RegisterScreen() {
  const { register, isSubmitting, error, clearError } = useRegisterCustomer();
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<FieldErrors<RegisterFormValues>>({});

  const setField = (field: keyof RegisterFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    clearError();
  };

  const submit = async () => {
    const validation = validateRegistration(values);
    if (!validation.success) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    try {
      await register(validation.data);
      Alert.alert(
        'Đăng ký thành công',
        'Tài khoản Customer đã được tạo. Bạn có thể đăng nhập ngay.',
        [{ text: 'Đăng nhập', onPress: () => router.replace('/login') }],
      );
    } catch {
      // The hook exposes the normalized API error to the screen.
    }
  };

  return (
    <AuthScreenLayout
      title="Đăng ký Customer"
      subtitle="Thông tin được dùng để tạo tài khoản và hồ sơ khách hàng vận tải."
      footer={
        <Link href="/login" asChild>
          <Pressable accessibilityRole="link" style={styles.linkButton}>
            <Text style={styles.linkText}>Đã có tài khoản? Đăng nhập</Text>
          </Pressable>
        </Link>
      }
    >
      {error ? <ScreenMessage message={error} /> : null}
      <FormField
        label="Tên đăng nhập"
        value={values.username}
        onChangeText={(value) => setField('username', value)}
        autoCapitalize="none"
        autoCorrect={false}
        error={errors.username}
      />
      <FormField
        label="Họ và tên"
        value={values.fullName}
        onChangeText={(value) => setField('fullName', value)}
        autoCapitalize="words"
        error={errors.fullName}
      />
      <FormField
        label="Số điện thoại"
        value={values.phone}
        onChangeText={(value) => setField('phone', value)}
        keyboardType="phone-pad"
        textContentType="telephoneNumber"
        error={errors.phone}
      />
      <FormField
        label="Email (không bắt buộc)"
        value={values.email}
        onChangeText={(value) => setField('email', value)}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="emailAddress"
        error={errors.email}
      />
      <FormField
        label="Mật khẩu"
        value={values.password}
        onChangeText={(value) => setField('password', value)}
        secureTextEntry
        textContentType="newPassword"
        error={errors.password}
      />
      <FormField
        label="Xác nhận mật khẩu"
        value={values.confirmPassword}
        onChangeText={(value) => setField('confirmPassword', value)}
        secureTextEntry
        textContentType="newPassword"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        error={errors.confirmPassword}
      />
      <PrimaryButton
        label="Tạo tài khoản"
        onPress={() => void submit()}
        loading={isSubmitting}
      />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  linkButton: { padding: spacing.sm },
  linkText: { color: colors.primary, fontWeight: '700', textAlign: 'center' },
});
