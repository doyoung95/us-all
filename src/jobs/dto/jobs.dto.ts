import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { AtLeastOneField } from '../../common/decorator/validator.decorator.js';
import { JobStatus } from '../types/jobs.types.js';

export class CreateJobBodyDto {
  @ApiProperty({ example: '테스트 제목' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ example: '테스트 내용' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class SearchJobQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ enum: JobStatus })
  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;
}

export class EditJobBodyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: JobStatus })
  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;

  @AtLeastOneField(['title', 'description', 'status'])
  private readonly _atLeastOneField?: never;
}
