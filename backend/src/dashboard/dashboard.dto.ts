import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

export const detailMetrics = ['candidateOrders', 'reviewOrders', 'availableVehicles', 'availableDrivers', 'expiredDrivers', 'blockedVehicles'] as const;
export type DetailMetric = typeof detailMetrics[number];
export class DashboardQuery {
  @IsOptional() @IsUUID() branchId?: string;
  @IsDateString({ strict: true }) @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/) from!: string;
  @IsDateString({ strict: true }) @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/) to!: string;
}
export class DashboardItemsQuery {
  @IsOptional() @IsUUID() branchId?: string;
  @IsIn(detailMetrics) metric!: DetailMetric;
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 20;
}
