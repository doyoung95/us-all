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
  EditJobStatusBodyDto,
  SearchJobQueryDto,
} from './dto/jobs.dto.js';
import { JobsService } from './jobs.service.js';
import { Job } from './types/jobs.types.js';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsSVC: JobsService) {}
  @Post()
  async create(@Body() body: CreateJobBodyDto): Promise<Job> {
    const job = await this.jobsSVC.create(body);

    return job;
  }

  @Get()
  getJobs(): Promise<Job[]> {
    return this.jobsSVC.getJobs();
  }

  @Get('/search')
  searchJobs(@Query() query: SearchJobQueryDto): Promise<Job[]> {
    return this.jobsSVC.searchJobs(query);
  }

  @Get('/:id')
  @ApiParam({
    name: 'id',
    type: String,
  })
  async getJob(@Param('id', ParseUUIDPipe) id: string): Promise<Job> {
    const { job } = await this.jobsSVC.getJob(id);
    return job;
  }

  @Patch('/:id')
  @ApiParam({
    name: 'id',
    type: String,
  })
  editJobProperty(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EditJobPropertyBodyDto,
  ): Promise<Job> {
    return this.jobsSVC.editJobProperty(id, body);
  }

  @Patch('/:id/cancel')
  @ApiParam({
    name: 'id',
    type: String,
    description: '대기,프로세싱(펜딩) => 취소',
  })
  changeStatusCancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EditJobStatusBodyDto,
  ): Promise<Job> {
    return this.jobsSVC.changeStatusCancel(id, body.version);
  }

  @Patch('/:id/wait')
  @ApiParam({
    name: 'id',
    type: String,
    description: '취소 => 대기 상태 변경',
  })
  changeStatusWait(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EditJobStatusBodyDto,
  ): Promise<Job> {
    return this.jobsSVC.changeStatusWait(id, body.version);
  }
}
