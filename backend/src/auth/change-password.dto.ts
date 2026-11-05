import { IsString, MaxLength, MinLength, Validate } from 'class-validator';
import { NewPasswordBytes } from '../users/users.dto';
import { BcryptPasswordLength } from './login.dto';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  @Validate(BcryptPasswordLength)
  currentPassword!: string;

  @IsString()
  @Validate(NewPasswordBytes)
  newPassword!: string;
}
