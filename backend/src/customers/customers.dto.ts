import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const optionalText = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() || null : value;

export class CustomerQueryDto {
  @IsOptional() @IsUUID() branchId?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) search?: string;
}

export class CustomerProfileDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) name: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(50) phone: string;
  @IsOptional() @Transform(optionalText) @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @Transform(optionalText) @IsString() @MaxLength(1000) address?: string | null;
  @IsOptional() @Transform(optionalText) @IsString() @MaxLength(150) contactPerson?: string | null;
  @IsOptional() @Transform(optionalText) @IsString() @MaxLength(50) taxCode?: string | null;
}

export class CreateCustomerDto extends CustomerProfileDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsUUID('all', { each: true }) branchIds: string[];
}

export class UpdateCustomerDto extends CustomerProfileDto {
  @IsInt() @Min(1) @Max(2147483646) version: number;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsUUID('all', { each: true }) branchIds?: string[];
}
