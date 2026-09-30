import { Transform } from 'class-transformer';
import { IsString, Length, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

@ValidatorConstraint({ name: 'bcryptPasswordLength' })
class BcryptPasswordLength implements ValidatorConstraintInterface {
  validate(value: unknown) { return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 72; }
  defaultMessage() { return 'Mật khẩu không được vượt quá 72 bytes UTF-8'; }
}

export class LoginDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 100)
  username!: string;

  @IsString()
  @Length(1, 72)
  @Validate(BcryptPasswordLength)
  password!: string;
}
