import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { WorkingHourItemDto } from './working-hour-item.dto';

export class ReplaceWorkingHoursDto {
  @IsString()
  businessId!: string;

  @IsOptional()
  @IsString()
  tz?: string;

  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WorkingHourItemDto)
  items!: WorkingHourItemDto[];
}
