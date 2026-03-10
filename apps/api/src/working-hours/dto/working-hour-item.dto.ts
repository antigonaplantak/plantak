import { IsInt, Max, Min } from 'class-validator';

export class WorkingHourItemDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @IsInt()
  @Min(0)
  @Max(1439)
  startMin!: number;

  @IsInt()
  @Min(1)
  @Max(1440)
  endMin!: number;
}
