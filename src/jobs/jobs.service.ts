import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Config, JsonDB } from 'node-json-db';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { random } from '../util/random.js';
import { JOB_MUTEX_MANAGER } from './jobs.token.js';
import {
  CreateJob,
  EditJobProperty,
  Job,
  JobStatus,
  SearchJobQuery,
} from './types/jobs.types.js';

@Injectable()
export class JobsService {
  private readonly db = new JsonDB(new Config('data/jobs', true, false, '/'));
  constructor(
    private runtimeSVC: RuntimeService,
    @Inject(JOB_MUTEX_MANAGER)
    private mutexManager: MutexManager,
  ) {}

  async onModuleInit() {
    try {
      await this.db.getData('/list[0]');
    } catch {
      await this.db.push('/list', []);
    }
  }

  async putRecover(job: Job) {
    const { idx } = await this.getJob(job.id);
    await this.db.push(`/list[${idx}]`, job, true);
  }

  async editStatusByIdx(idx: number, status: JobStatus) {
    await this.db.push(`/list[${idx}]`, { status }, false);
  }

  async create(data: CreateJob) {
    try {
      const id = randomUUID();
      const job = {
        id,
        title: data.title,
        description: data.description,
        status: JobStatus.waiting,
        processingTime: random(1, 20),
        reservationTime: random(1, 20) + this.runtimeSVC.getRunningSec(),
      };
      await this.db.push('/list[]', job);
      return job;
    } catch (error) {
      console.error(error);
      throw new InternalServerErrorException();
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

  async editJobProperty(id: string, data: EditJobProperty) {
    return this.mutexManager.run<Job>(id, async () => {
      const { idx, job } = await this.getJob(id);

      switch (job.status) {
        case JobStatus.completed:
          throw new ConflictException('완료된 작업은 수정할 수 없습니다.');
        case JobStatus.pending:
          throw new ConflictException('처리중인 작업은 수정할 수 없습니다.');
        default:
      }

      const patchData = Object.fromEntries(
        Object.entries(data).filter(([_, value]) => value !== undefined),
      );

      await this.db.push(`/list[${idx}]`, patchData, false);

      return { ...job, ...patchData };
    });
  }

  // TODO job 버전 관리 필요
  async changeStatusCancel(id: string) {
    return this.mutexManager.run<Job>(id, async () => {
      const { idx, job } = await this.getJob(id);
      if (
        job.status !== JobStatus.waiting &&
        job.status !== JobStatus.pending
      ) {
        throw new ConflictException('대기/처리중인 작업만 취소 가능합니다');
      }

      await this.editStatusByIdx(idx, JobStatus.canceled);

      return { ...job, status: JobStatus.canceled };
    });
  }

  async changeStatusWait(id: string) {
    return this.mutexManager.run<Job>(id, async () => {
      const { idx, job } = await this.getJob(id);
      if (job.status !== JobStatus.canceled) {
        throw new ConflictException('취소된 작업만 복구 가능합니다.');
      }

      await this.editStatusByIdx(idx, JobStatus.waiting);
      return { ...job, status: JobStatus.waiting };
    });
  }
}
