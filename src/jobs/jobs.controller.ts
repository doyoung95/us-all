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
  EditJobBodyDto,
  SearchJobQueryDto,
} from './dto/jobs.dto.js';
import { JobsService } from './jobs.service.js';

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
  editJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EditJobBodyDto,
  ) {
    return this.jobsSVC.editJob(id, body);
  }
}
