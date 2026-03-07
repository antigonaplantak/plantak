import { IsArray, IsBoolean, IsInt, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export class StaffServiceAssignmentItemDto {
  @IsString()
  serviceId!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  onlineBookingEnabled?: boolean;

  @IsOptional()
  @IsInt()
  durationMinOverride?: number;

  @IsOptional()
  @IsInt()
  priceCentsOverride?: number;

  @IsOptional()
  @IsInt()
  bufferBeforeMinOverride?: number;

  @IsOptional()
  @IsInt()
  bufferAfterMinOverride?: number;
}

export class ReplaceStaffServicesDto {
  @IsString()
  businessId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StaffServiceAssignmentItemDto)
  items!: StaffServiceAssignmentItemDto[];
}
