import { IsString, MinLength } from 'class-validator';

export class AcceptStaffInviteDto {
  @IsString()
  @MinLength(10)
  token!: string;
}
