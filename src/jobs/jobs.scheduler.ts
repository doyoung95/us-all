import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JobsService } from './jobs.service.js';
import { JOB_MUTEX_MANAGER } from './jobs.token.js';
import { Job, JobStatus } from './types/jobs.types.js';
import { process } from './util/process.js';

@Injectable()
export class JobsScheduler {
  constructor(
    private readonly runtimeSVC: RuntimeService,
    private readonly jobsSVC: JobsService,
    @Inject(JOB_MUTEX_MANAGER)
    private readonly mutexManager: MutexManager,
  ) {}

  // TODO 리커버리 코드 필요

  private async process(job: Job) {
    await process(job.processingTime);

    await this.mutexManager.run(job.id, async () => {
      const { job: lockedJob } = await this.jobsSVC.getJob(job.id);
      // TODO 취소된 케이스 원복 필요
      if (lockedJob.status !== JobStatus.pending) {
        return;
      }
      await this.jobsSVC.editStatusById(job.id, JobStatus.completed);
    });
  }

  @Cron('*/5 * * * * *')
  async consume() {
    // 멀티 인스턴스일 때 메인 인스턴스만 스케쥴러 돌도록
    const isPrimary = true;
    if (!isPrimary) return;

    // TODO reservation 처리 위해서 조회 query 추가
    const jobs = await this.jobsSVC.searchJobs({
      status: JobStatus.waiting,
    });

    if (jobs.length === 0) {
      return;
    }

    const job = jobs[0];

    const claimed = await this.mutexManager.run<Boolean>(job.id, async () => {
      const { job: lockedJob } = await this.jobsSVC.getJob(job.id);
      if (lockedJob.status !== JobStatus.waiting) return false;
      await this.jobsSVC.editStatusById(job.id, JobStatus.pending);
      return true;
    });

    // TODO 다른 job 찾는 작업 필요
    if (!claimed) {
      return;
    }

    // fire-and-forget
    this.process(job);
  }
}
