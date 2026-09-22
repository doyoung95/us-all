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
import { AppLogger } from '../logger/app-logger.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { random } from '../util/random.js';
import { JOB_MUTEX_MANAGER } from './jobs.token.js';
import {
  CreateJob,
  EditJobProperty,
  Job,
  JobStatus,
  SearchJobQuery,
  UpdateJobData,
} from './types/jobs.types.js';

@Injectable()
export class JobsService {
  private readonly db = new JsonDB(new Config('data/jobs', true, false, '/'));
  constructor(
    private runtimeSVC: RuntimeService,
    @Inject(JOB_MUTEX_MANAGER)
    private mutexManager: MutexManager,
    private readonly logger: AppLogger,
  ) {}

  private validateVersion(job: Job, requestedVersion: number) {
    if (job.version !== requestedVersion) {
      throw new ConflictException(
        `버전이 일치하지 않습니다. current=${job.version}, request=${requestedVersion}`,
      );
    }
  }

  async updateJob(
    idx: number,
    job: Job,
    patchData: UpdateJobData,
  ): Promise<Job> {
    const nextVersion = job.version + 1;

    const updatedJob = {
      ...job,
      ...patchData,
      version: nextVersion,
    };

    await this.db.push(
      `/list[${idx}]`,
      {
        ...patchData,
        version: nextVersion,
      },
      false,
    );

    return updatedJob;
  }

  async onModuleInit() {
    try {
      await this.db.getData('/list[0]');
    } catch {
      await this.db.push('/list', []);
    }
  }

  async create(data: CreateJob) {
    try {
      const id = randomUUID();
      const job: Job = {
        id,
        version: 1,
        title: data.title,
        description: data.description,
        status: JobStatus.waiting,
        processingTime: random(1, 20),
        reservationTime: random(1, 20) + this.runtimeSVC.getRunningSec(),
      };
      await this.db.push('/list[]', job);

      this.logger.log('job.created', {
        jobId: id,
        processingTime: job.processingTime,
        reservationTime: job.reservationTime,
      });

      return job;
    } catch (error) {
      this.logger.error('job.create.failed', error, { title: data.title });
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
    const { version, ...properties } = data;
    return this.mutexManager.run<Job>(id, async () => {
      const { idx, job } = await this.getJob(id);

      this.validateVersion(job, version);

      switch (job.status) {
        case JobStatus.completed:
          throw new ConflictException('완료된 작업은 수정할 수 없습니다.');
        case JobStatus.pending:
          throw new ConflictException('처리중인 작업은 수정할 수 없습니다.');
        default:
      }

      const patchData = Object.fromEntries(
        Object.entries(properties).filter(([_, value]) => value !== undefined),
      );

      const updatedJob = await this.updateJob(idx, job, patchData);

      this.logger.log('job.updated', {
        jobId: id,
        fields: Object.keys(patchData).join(','),
      });

      return updatedJob;
    });
  }

  async changeStatusCancel(id: string, version: number) {
    return this.mutexManager.run<Job>(id, async () => {
      const { idx, job } = await this.getJob(id);

      this.validateVersion(job, version);

      if (
        job.status !== JobStatus.waiting &&
        job.status !== JobStatus.pending
      ) {
        throw new ConflictException('대기/처리중인 작업만 취소 가능합니다');
      }

      const updatedJob = await this.updateJob(idx, job, {
        status: JobStatus.canceled,
      });

      this.logger.log('job.canceled', { jobId: id, from: job.status });

      return updatedJob;
    });
  }

  async changeStatusWait(id: string, version: number) {
    return this.mutexManager.run<Job>(id, async () => {
      const { idx, job } = await this.getJob(id);

      this.validateVersion(job, version);

      if (job.status !== JobStatus.canceled) {
        throw new ConflictException('취소된 작업만 복구 가능합니다.');
      }

      const updatedJob = await this.updateJob(idx, job, {
        status: JobStatus.waiting,
      });

      this.logger.log('job.waiting.restored', { jobId: id });

      return updatedJob;
    });
  }
}
