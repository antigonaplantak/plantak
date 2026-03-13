import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { WorkingHourItemDto } from './working-hour-item.dto';

export class ReplaceWorkingHoursDto {
  @IsDefined()
  @IsString()
  businessId!: string;

  @IsOptional()
  @IsString()
  tz?: string;

  @IsDefined()
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WorkingHourItemDto)
  items!: WorkingHourItemDto[];
}
