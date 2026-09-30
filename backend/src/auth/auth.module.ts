import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { authConfig } from './auth.config';
import { PermissionGuard, SessionGuard } from './access.guard';
import { ApiErrorFilter } from './api-error.filter';
import { ResourceAccess } from './resource-access.service';

@Global()
@Module({
  imports: [PassportModule, JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: authConfig(config).secret, signOptions: { algorithm: 'HS256', issuer: 'tms', audience: 'tms-web' }, verifyOptions: { algorithms: ['HS256'], issuer: 'tms', audience: 'tms-web' } }) })],
  providers: [AuthService, JwtStrategy, ResourceAccess, { provide: APP_GUARD, useClass: SessionGuard }, { provide: APP_GUARD, useClass: PermissionGuard }, { provide: APP_FILTER, useClass: ApiErrorFilter }],
  controllers: [AuthController], exports: [AuthService, ResourceAccess],
})
export class AuthModule {}
