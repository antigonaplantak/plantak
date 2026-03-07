import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export enum InviteRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  STAFF = 'STAFF',
}

export class CreateStaffInviteDto {
  @IsString()
  @MinLength(1)
  businessId!: string;

  @IsString()
  @MinLength(1)
  staffId!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsEnum(InviteRole)
  role?: InviteRole;
}
