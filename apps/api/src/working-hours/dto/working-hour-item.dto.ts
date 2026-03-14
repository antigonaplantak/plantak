import { IsDefined, IsInt, Max, Min } from 'class-validator';

export class WorkingHourItemDto {
  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(1439)
  startMin!: number;

  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(1440)
  endMin!: number;
}
