import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Config, JsonDB } from 'node-json-db';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { random } from '../util/random.js';
import {
  CreateJob,
  EditJob,
  EditJobProperty,
  Job,
  JobStatus,
  SearchJobQuery,
} from './types/jobs.types.js';

@Injectable()
export class JobsService {
  private readonly db = new JsonDB(new Config('data/jobs', true, false, '/'));
  constructor(private runtimeSVC: RuntimeService) {}

  async onModuleInit() {
    try {
      await this.db.getData('/list[0]');
    } catch {
      await this.db.push('/list', []);
    }
  }

  async create(data: CreateJob) {
    try {
      await this.db.push('/list[]', {
        id: randomUUID(),
        title: data.title,
        description: data.description,
        status: JobStatus.waiting,
        processingTime: random(1, 20),
        reservationTime: random(1, 20) + this.runtimeSVC.getRunningSec(),
      });
    } catch (error) {
      console.error(error);
    }
  }

  getJobs() {
    return this.db.getData(`/list`);
  }

  async searchJobs(query: SearchJobQuery) {
    const { title, status } = query;
    const list = (await this.getJobs()) as Job[];

    if (!title && !status) return list;

    return list.filter((job) => {
      if (title && !job.title.includes(title)) {
        return false;
      }
      if (status && job.status !== status) {
        return false;
      }
      return true;
    });
  }

  async getJob(id: string) {
    const idx = await this.db.getIndex('/list', id);
    if (idx === -1) {
      throw new NotFoundException();
    }
    const job = (await this.db.getData(`/list[${idx}]`)) as Job;
    return {
      idx,
      job,
    };
  }

  private async editProperty(idx: number, data: EditJobProperty) {
    const patchData = Object.fromEntries(
      Object.entries(data).filter(([_, value]) => value !== undefined),
    );

    await this.db.push(`/list[${idx}]`, patchData, false);
  }

  private async editStatus(idx: number, status: JobStatus) {
    await this.db.push(`/list[${idx}]`, { status }, false);
  }

  // TODO lock 필요
  // TODO 상태 변경 로직 분리 필요
  async editJob(id: string, data: EditJob) {
    const { title, description, status } = data;
    const { idx, job } = await this.getJob(id);

    // 작업중인 job은 수정 불가
    if (job.status === JobStatus.pending) {
      throw new ConflictException('작업중인 job은 수정할 수 없습니다.');
    }

    if (title !== undefined || description !== undefined) {
      await this.editProperty(idx, { title, description });
    }

    if (status !== undefined && Object.values(JobStatus).includes(status)) {
      // 완료된 작업은 상태 수정 불가
      if (status === JobStatus.completed) {
        throw new ConflictException('완료된 작업입니다.');
      }
      await this.editStatus(idx, status);
    }
  }
}
