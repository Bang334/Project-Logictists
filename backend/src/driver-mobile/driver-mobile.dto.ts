import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  IsUUID,
  ValidateNested,
  Equals,
} from "class-validator";

export class AssignmentQuery {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
  @IsOptional() @IsIn(["ASSIGNED", "ACCEPTED", "REJECTED"]) status?: string;
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}
export class AssignmentResponseDto {
  @IsInt() @Min(1) expectedVersion: number;
  @IsInt() @Min(1) expectedTripVersion: number;
}
export class RejectAssignmentDto extends AssignmentResponseDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason: string;
}

export class InspectPickupDto extends AssignmentResponseDto {
  @IsString() @MinLength(1) @MaxLength(256) qrCode: string;
}
export class PickupPackageDto extends InspectPickupDto {
  @Equals(true) loadedOnVehicle: boolean;
}
export class MissingPickupDto {
  @IsUUID() taskId: string;
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(1000) reason: string;
}
export class CompletePickupDto extends AssignmentResponseDto {
  @IsIn(['FULL', 'PARTIAL', 'NONE']) declaredOutcome: 'FULL' | 'PARTIAL' | 'NONE';
  @IsArray() @ArrayMaxSize(1000) @ArrayUnique((entry: MissingPickupDto) => entry.taskId)
  @ValidateNested({ each: true }) @Type(() => MissingPickupDto) missing: MissingPickupDto[];
}
