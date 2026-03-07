import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateServiceCategoryDto {
  @IsString()
  businessId!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsInt()
  position?: number;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
}
