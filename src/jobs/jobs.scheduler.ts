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

  private async processJob(job: Job) {
    await process(job.processingTime);

    await this.completeJob(job);
  }

  private async completeJob(job: Job) {
    await this.mutexManager.run(job.id, async () => {
      const { idx, job: lockedJob } = await this.jobsSVC.getJob(job.id);
      // TODO 취소된 케이스 원복 필요
      if (lockedJob.status !== JobStatus.pending) {
        return;
      }
      await this.jobsSVC.editStatusByIdx(idx, JobStatus.completed);
    });
  }

  private async getClaimJob(id: string) {
    return this.mutexManager.run<Job | null>(id, async () => {
      // TODO reservation 처리 위해서 조회 query 추가
      const { idx, job: lockedJob } = await this.jobsSVC.getJob(id);

      if (lockedJob.status !== JobStatus.waiting) return null;

      await this.jobsSVC.editStatusByIdx(idx, JobStatus.pending);

      return {
        ...lockedJob,
        status: JobStatus.pending,
      };
    });
  }

  private async claimJob() {
    const jobs = await this.jobsSVC.searchJobs({
      status: JobStatus.waiting,
    });

    if (jobs.length === 0) {
      return null;
    }

    for (const job of jobs) {
      const claimJob = await this.getClaimJob(job.id);

      if (claimJob) return claimJob;
    }

    return null;
  }

  @Cron('*/5 * * * * *', {
    // getClaimJob 순회 완료되지 않은 경우 틱 중지
    waitForCompletion: true,
  })
  async consume() {
    // 멀티 인스턴스일 때 메인 인스턴스만 스케쥴러 돌도록
    const isPrimary = true;
    if (!isPrimary) return;

    const claimJob = await this.claimJob();

    // TODO 다른 job 찾는 작업 필요
    if (!claimJob) {
      return;
    }

    // fire-and-forget
    this.processJob(claimJob);
  }
}
