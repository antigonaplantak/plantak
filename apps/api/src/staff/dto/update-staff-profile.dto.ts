import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateStaffProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}
