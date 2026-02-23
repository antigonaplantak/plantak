import { IsBoolean } from 'class-validator';

export class SetServiceStatusDto {
  @IsBoolean()
  isActive: boolean;
}
