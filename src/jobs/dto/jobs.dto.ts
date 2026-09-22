import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { AtLeastOneField } from '../../common/decorator/validator.decorator.js';
import { JobStatus } from '../types/jobs.types.js';

export class CreateJobBodyDto {
  @ApiProperty({ example: '테스트 제목' })
  @IsString()
  @IsNotEmpty({ message: '작업 타이틀을 입력해주세요.' })
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

export class EditJobPropertyBodyDto {
  @ApiProperty({
    description:
      '요청 시점의 버전 명시 (작업 시점의 버전이 다를 경우 에러 반환)',
  })
  @IsNumber()
  version: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @AtLeastOneField(['title', 'description'], {
    message: '변경할 데이터를 입력해주세요.',
  })
  private readonly _atLeastOneField?: never;
}

export class EditJobStatusBodyDto {
  @ApiProperty({
    description:
      '요청 시점의 버전 명시 (작업 시점의 버전이 다를 경우 에러 반환)',
  })
  @IsNumber()
  version: number;
}
