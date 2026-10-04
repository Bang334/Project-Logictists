import { IsInt, Max, Min } from 'class-validator';

export class ApplyOptimizationCandidateDto {
  @IsInt()
  @Min(1)
  @Max(10)
  candidateNumber!: number;
}
