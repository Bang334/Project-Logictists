import { Type } from "class-transformer";
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import {
  DELIVERY_RESULTS,
  DeliveryResult,
  DRIVER_EXECUTION_REASON_CODES,
  DriverExecutionReasonCode,
} from "../driver-trip-execution.constants";

export class DriverTripCommandDto {
  @IsUUID()
  idempotencyKey!: string;

  @IsInt()
  @Min(1)
  expectedTripVersion!: number;
}

export class ArriveDriverStopDto extends DriverTripCommandDto {
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  occurredAt?: string;
}

export class StopTaskExecutionDto {
  @IsUUID()
  taskId!: string;

  @IsInt()
  @Min(0)
  actualQuantity!: number;
}

export class CompleteDriverStopDto extends DriverTripCommandDto {
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  occurredAt?: string;

  @IsArray()
  @ArrayUnique((task: StopTaskExecutionDto) => task.taskId)
  @ValidateNested({ each: true })
  @Type(() => StopTaskExecutionDto)
  tasks!: StopTaskExecutionDto[];

  @IsOptional()
  @IsIn(DELIVERY_RESULTS)
  deliveryResult?: DeliveryResult | null;

  @IsOptional()
  @IsIn(DRIVER_EXECUTION_REASON_CODES)
  reasonCode?: DriverExecutionReasonCode | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  recipientName?: string | null;
}
