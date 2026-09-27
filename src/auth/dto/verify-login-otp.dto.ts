import { IsString, Length, Matches } from 'class-validator';
import { ResendLoginOtpDto } from './resend-login-otp.dto';

export class VerifyLoginOtpDto extends ResendLoginOtpDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^[0-9]{6}$/)
  code!: string;
}
