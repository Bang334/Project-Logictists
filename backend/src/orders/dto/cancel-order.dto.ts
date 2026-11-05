import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class CancelOrderDto {
  @IsInt() @Min(1) @Max(2147483647) version: number;
  @IsString() @MaxLength(1000) @Matches(/\S/u, { message: 'Lý do hủy không được để trống' }) reason: string;
}
