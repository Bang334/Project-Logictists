import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { auditEntities } from './audit-projection';

export class AuditQueryDto {
  @IsISO8601({ strict: true }) @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/) from!: string;
  @IsISO8601({ strict: true }) @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/) to!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsIn(Object.keys(auditEntities)) entityType?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z_]{1,60}$/) action?: string;
  @IsOptional() @IsString() @Matches(/^[\w-]{1,100}$/) actorUserId?: string;
  @IsOptional() @IsString() @MaxLength(100) @Matches(/^[\w-]{1,100}$/) entityId?: string;
  @IsOptional() @IsString() @Matches(/^[\w-]{1,100}$/) branchId?: string;
}
