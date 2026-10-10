import { ConfigService } from '@nestjs/config';
import { authConfig } from './auth.config';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { LoginDto } from './login.dto';

describe('authentication configuration and validation', () => {
  it('fails without a sufficiently long explicit JWT secret', () => {
    expect(() => authConfig(new ConfigService({ JWT_SECRET: '' }))).toThrow('JWT_SECRET');
    expect(() => authConfig(new ConfigService({ JWT_SECRET: 'short' }))).toThrow('JWT_SECRET');
  });
  it('rejects invalid limiter and expiry settings', () => {
    for (const key of ['AUTH_ACCESS_TTL_SECONDS', 'AUTH_LOGIN_WINDOW_SECONDS', 'AUTH_LOGIN_MAX_ATTEMPTS', 'AUTH_LOGIN_IP_MAX_ATTEMPTS']) {
      expect(() => authConfig(new ConfigService({ JWT_SECRET: 'x'.repeat(32), [key]: '0' }))).toThrow(key);
    }
  });
  it('rejects bcrypt byte truncation and trims only the login name', async () => {
    const invalid = plainToInstance(LoginDto, { username: ' user ', password: 'ế'.repeat(25) });
    expect(invalid.username).toBe('user');
    expect((await validate(invalid)).some(e => e.property === 'password')).toBe(true);
    const valid = plainToInstance(LoginDto, { username: ' user ', password: ' spaces preserved ' });
    expect(await validate(valid)).toHaveLength(0);
    expect(valid.password).toBe(' spaces preserved ');
  });
});
