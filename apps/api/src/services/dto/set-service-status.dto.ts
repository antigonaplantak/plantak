import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class SetServiceStatusDto {
  @IsOptional()
  @IsIn(["PUBLIC", "PRIVATE"])
  visibility?: "PUBLIC" | "PRIVATE";

  @IsOptional()
  @IsBoolean()
  onlineBookingEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
