import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import {
  CreateJobBodyDto,
  EditJobPropertyBodyDto,
  SearchJobQueryDto,
} from './dto/jobs.dto.js';
import { JobsService } from './jobs.service.js';
import { JobStatus } from './types/jobs.types.js';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsSVC: JobsService) {}
  @Post()
  create(@Body() body: CreateJobBodyDto) {
    this.jobsSVC.create(body);
  }

  @Get()
  getJobs() {
    return this.jobsSVC.getJobs();
  }

  @Get('/search')
  searchJobs(@Query() query: SearchJobQueryDto) {
    return this.jobsSVC.searchJobs(query);
  }

  @Get('/:id')
  @ApiParam({
    name: 'id',
    type: String,
  })
  getJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobsSVC.getJob(id);
  }

  @Patch('/:id')
  @ApiParam({
    name: 'id',
    type: String,
  })
  editJobProperty(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EditJobPropertyBodyDto,
  ) {
    return this.jobsSVC.editJobProperty(id, body);
  }

  @Patch('/:id/:status')
  @ApiParam({
    name: 'id',
    type: String,
    description: '대기,프로세싱(펜딩) => 취소 / 취소 => 대기 상태 변경',
  })
  @ApiParam({
    name: 'status',
    type: String,
    description:
      '대기,프로세싱(펜딩) => 취소 / 취소 => 대기 상태 변경 (상태 명시 필수)',
  })
  editJobStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('status') status: JobStatus,
  ) {
    return this.jobsSVC.editJobStatus(id, status);
  }
}
