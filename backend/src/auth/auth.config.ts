import { ConfigService } from '@nestjs/config';

export function authConfig(config: ConfigService) {
  const secret = config.get<string>('JWT_SECRET');
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('JWT_SECRET phải được cấu hình riêng, tối thiểu 32 bytes');
  const integer = (name: string, fallback: number) => {
    const value = Number(config.get<string>(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} phải là số nguyên dương`);
    return value;
  };
  return { secret, ttl: integer('AUTH_ACCESS_TTL_SECONDS', 1800), window: integer('AUTH_LOGIN_WINDOW_SECONDS', 900), limit: integer('AUTH_LOGIN_MAX_ATTEMPTS', 10), ipLimit: integer('AUTH_LOGIN_IP_MAX_ATTEMPTS', 100) };
}
