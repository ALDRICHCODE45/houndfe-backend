import {
  IsEmail,
  IsString,
  MinLength,
  IsNotEmpty,
  IsUUID,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsUUID()
  roleId: string;
}
