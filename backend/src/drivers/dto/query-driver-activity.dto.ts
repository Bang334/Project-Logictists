import { IsString, MaxLength } from 'class-validator';

export class QueryDriverActivityDto {
  @IsString()
  @MaxLength(35)
  from!: string;

  @IsString()
  @MaxLength(35)
  to!: string;
}
