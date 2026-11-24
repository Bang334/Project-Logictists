import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Link } from 'expo-router';
import { AuthScreenLayout } from '@/features/auth/components/AuthScreenLayout';
import { FormField } from '@/features/auth/components/FormField';
import { useAuth } from '@/features/auth/hooks/useAuth';
import type {
  FieldErrors,
  LoginFormValues,
} from '@/features/auth/types/auth.types';
import { validateLogin } from '@/features/auth/validation/auth.validation';
import { toUserMessage } from '@/shared/api/api-error';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';

const initialValues: LoginFormValues = { username: '', password: '' };

export function LoginScreen() {
  const { login, isAuthenticating } = useAuth();
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<FieldErrors<LoginFormValues>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = async () => {
    const validation = validateLogin(values);
    if (!validation.success) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setSubmitError(null);
    try {
      await login(validation.data);
    } catch (error) {
      setSubmitError(toUserMessage(error));
    }
  };

  return (
    <AuthScreenLayout
      title="Đăng nhập"
      subtitle="Truy cập ứng dụng Smart TMS theo tài khoản được cấp."
      footer={
        <Link href="/register" asChild>
          <Pressable accessibilityRole="link" style={styles.linkButton}>
            <Text style={styles.linkText}>Chưa có tài khoản? Đăng ký Customer</Text>
          </Pressable>
        </Link>
      }
    >
      {submitError ? <ScreenMessage message={submitError} /> : null}
      <FormField
        label="Tên đăng nhập"
        value={values.username}
        onChangeText={(username) => setValues((current) => ({ ...current, username }))}
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="username"
        returnKeyType="next"
        error={errors.username}
      />
      <FormField
        label="Mật khẩu"
        value={values.password}
        onChangeText={(password) => setValues((current) => ({ ...current, password }))}
        secureTextEntry
        textContentType="password"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        error={errors.password}
      />
      <PrimaryButton
        label="Đăng nhập"
        onPress={() => void submit()}
        loading={isAuthenticating}
      />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  linkButton: { padding: spacing.sm },
  linkText: { color: colors.primary, fontWeight: '700', textAlign: 'center' },
});
