import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';

/** Вход по логину или по email (достаточно одного из полей). */
export class LoginDto {
  @ApiPropertyOptional({ example: 'admin', description: 'Логин (если не указан email)' })
  @ValidateIf((o) => !o.email)
  @IsOptional()
  @IsString()
  login?: string;

  @ApiPropertyOptional({ example: 'anna@example.com', description: 'Email (если не указан login)' })
  @ValidateIf((o) => !o.login)
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ example: '123Qwe', minLength: 1 })
  @IsString()
  @MinLength(1)
  password!: string;
}
