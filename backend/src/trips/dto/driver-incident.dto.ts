import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from "class-validator";
import {
  DRIVER_INCIDENT_SEVERITIES,
  DRIVER_INCIDENT_STATUSES,
  DRIVER_INCIDENT_TYPES,
  DriverIncidentSeverity,
  DriverIncidentType,
} from "../driver-incidents.constants";

export class CreateDriverIncidentDto {
  @IsUUID("4")
  idempotencyKey!: string;

  @IsIn(DRIVER_INCIDENT_TYPES)
  type!: DriverIncidentType;

  @IsIn(DRIVER_INCIDENT_SEVERITIES)
  severity!: DriverIncidentSeverity;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @Length(10, 2000)
  description!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  occurredAt!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID("4", { each: true })
  affectedOrderIds?: string[];
}

export class QueryDriverIncidentsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsIn(DRIVER_INCIDENT_TYPES)
  type?: DriverIncidentType;

  @IsOptional()
  @IsIn(DRIVER_INCIDENT_STATUSES)
  status?: string;
}
