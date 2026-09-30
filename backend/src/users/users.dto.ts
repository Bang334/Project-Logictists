import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, ArrayUnique, Equals, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

@ValidatorConstraint({ name: 'newPasswordBytes' })
export class NewPasswordBytes implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 12 && Buffer.byteLength(value, 'utf8') <= 72;
  }
  defaultMessage() { return 'password phải có từ 12 đến 72 byte UTF-8'; }
}
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class CreateUserDto {
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  username!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 200)
  fullName!: string;

  @IsString()
  @Validate(NewPasswordBytes)
  password!: string;

  @Equals('DISPATCHER', { message: 'roleCode phải là DISPATCHER' })
  roleCode!: 'DISPATCHER';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  branchIds!: string[];
}

export class ListUsersDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 100)
  search?: string;

  @IsOptional()
  @IsIn(['active', 'locked'])
  status?: 'active' | 'locked';

  @IsOptional()
  @IsUUID()
  branchId?: string;
}
