import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateUserDto, ListUsersDto } from './users.dto';
import { hasPermission, Principal } from '../auth/access';

describe('account boundaries', () => {
  const valid = { username: ' user ', fullName: ' Name ', password: '🔐'.repeat(3), roleCode: 'DISPATCHER', branchIds: ['9e03c09a-9341-4bc8-97a8-a358e2affb08'] };
  it('trims identifiers and counts UTF-8 bytes without trimming passwords', async () => {
    const dto = plainToInstance(CreateUserDto, valid);
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.username).toBe('user'); expect(dto.fullName).toBe('Name');
    for (const password of ['a'.repeat(11), '🔐'.repeat(19), '', 12]) expect((await validate(plainToInstance(CreateUserDto, { ...valid, password }))).length).toBeGreaterThan(0);
    expect(await validate(plainToInstance(CreateUserDto, { ...valid, password: '🔐'.repeat(18) }))).toHaveLength(0);
  });
  it('rejects missing role, invalid/duplicate branches and unbounded pagination', async () => {
    for (const change of [{ roleCode: undefined }, { roleCode: 'ADMIN' }, { branchIds: [] }, { branchIds: undefined }, { branchIds: [...valid.branchIds, ...valid.branchIds] }]) expect((await validate(plainToInstance(CreateUserDto, { ...valid, ...change }))).length).toBeGreaterThan(0);
    for (const pageSize of [0, -1, 101, 'bad']) expect((await validate(plainToInstance(ListUsersDto, { pageSize }))).length).toBeGreaterThan(0);
  });
  it('requires the exact username and a COMPANY ADMIN permission on the same grant', () => {
    const user: Principal = { id: 'u', sessionId: 's', username: 'demo_auth_admin', fullName: 'Admin', grants: [{ role: 'ADMIN', scopeType: 'COMPANY', branchId: null, permissions: ['users.read'] }] };
    expect(hasPermission(user, 'users.read')).toBe(true);
    expect(hasPermission({ ...user, username: 'other_admin' }, 'users.read')).toBe(false);
    expect(hasPermission({ ...user, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'b', permissions: ['users.read'] }] }, 'users.read')).toBe(false);
    expect(hasPermission(user, 'users.create')).toBe(false);
  });
});
