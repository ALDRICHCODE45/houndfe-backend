import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsUrl,
} from 'class-validator';

export class CreateImageDto {
  @IsString()
  @IsUrl()
  url: string;

  @IsOptional()
  @IsBoolean()
  isMain?: boolean;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsString()
  variantId?: string;
}
