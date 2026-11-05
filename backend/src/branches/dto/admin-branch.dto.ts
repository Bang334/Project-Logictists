import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

export class CreateBranchDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @Matches(/^[A-Z0-9][A-Z0-9_-]{1,39}$/)
  code!: string;
  @IsString() @Length(1, 200) name!: string;
  @IsString() @Length(1, 500) address!: string;
  @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @IsNumber() @Min(-180) @Max(180) longitude!: number;
  @IsOptional() @IsString() @Length(0, 40) phone?: string;
}
export class BranchStatusDto {
  @IsDateString() expectedUpdatedAt!: string;
  @IsBoolean() active!: boolean;
}
export class BranchListDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsString() @Length(0, 100) search?: string;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
}
