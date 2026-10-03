import { IsInt, Min } from 'class-validator';

export class PublishTripDto {
  @IsInt()
  @Min(1)
  expectedVersion: number;
}
