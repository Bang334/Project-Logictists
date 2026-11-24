import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export class RegisterCustomerDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(4, 50)
  @Matches(/^[a-z0-9._-]+$/, {
    message:
      'username chỉ được chứa chữ thường, số, dấu chấm, gạch dưới hoặc gạch ngang',
  })
  username: string;

  @IsString()
  @Length(8, 72)
  password: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  fullName: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/[\s.-]/g, '') : value,
  )
  @IsString()
  @Matches(/^\+?[0-9]{9,15}$/, {
    message: 'phone phải có từ 9 đến 15 chữ số và có thể bắt đầu bằng dấu +',
  })
  phone: string;

  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    return normalized === '' ? undefined : normalized;
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
