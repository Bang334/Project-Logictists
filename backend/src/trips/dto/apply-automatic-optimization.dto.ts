import { IsObject, IsString, MinLength } from 'class-validator';

export class ApplyAutomaticOptimizationDto {
  @IsObject()
  proposal!: Record<string, unknown>;

  @IsString()
  @MinLength(32)
  signature!: string;
}
