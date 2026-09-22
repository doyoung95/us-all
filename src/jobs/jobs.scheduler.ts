import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { AppLogger } from '../logger/app-logger.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JobsService } from './jobs.service.js';
import { JOB_MUTEX_MANAGER } from './jobs.token.js';
import { RecoverJobService } from './recover-job/recover-job.service.js';
import { Job, JobStatus } from './types/jobs.types.js';
import { process } from './util/process.js';

@Injectable()
export class JobsScheduler {
  private recovered = false;
  private isPrimary: boolean;
  private processingSet = new Set();
  constructor(
    private readonly runtimeSVC: RuntimeService,
    private readonly jobsSVC: JobsService,
    private readonly recoverSVC: RecoverJobService,
    @Inject(JOB_MUTEX_MANAGER)
    private readonly mutexManager: MutexManager,
    private readonly logger: AppLogger,
  ) {
    // 멀티 인스턴스일 때 메인 인스턴스만 스케쥴러 돌도록
    this.isPrimary = true;
  }

  get isRecovered() {
    return this.recovered;
  }

  async onApplicationBootstrap() {
    if (!this.isPrimary) return;

    this.logger.log('scheduler.bootstrap.start');
    const recoverJobs = await this.recoverSVC.getRecovers();

    let failedCount = 0;
    for (const recoverJob of recoverJobs) {
      await this.mutexManager.run(recoverJob.id, async () => {
        try {
          const { idx, job } = await this.jobsSVC.getJob(recoverJob.id);

          // pending update 전 recover 저장하기 때문에 +1
          const claimedVersion = recoverJob.version + 1;
          if (job.version !== claimedVersion) {
            this.logger.warn('job.recovered.stale', {
              jobId: job.id,
              claimed: claimedVersion,
              current: job.version,
              status: job.status,
            });
            await this.recoverSVC.removeRecover(job.id);
            return;
          }

          // 무조건 pending 상태. waiting으로 변경
          await this.jobsSVC.updateJob(idx, job, {
            status: JobStatus.waiting,
          });

          await this.recoverSVC.removeRecover(job.id);
          this.logger.log('job.recovered', {
            jobId: recoverJob.id,
            from: job.status,
            to: JobStatus.waiting,
          });
        } catch (error) {
          failedCount++;
          this.logger.error('job.recover.failed', error, {
            jobId: recoverJob.id,
          });
        }
      });
    }

    this.logger.log('scheduler.bootstrap.end', {
      total: recoverJobs.length,
      failed: failedCount,
    });

    this.recovered = true;
  }

  private async processJob(job: Job) {
    try {
      await process(job.processingTime);
      await this.completeJob(job);
    } catch (error) {
      // TODO 실패한 job 상태 복구
      // TODO 재시도 횟수 + 초과시 알림
      this.logger.error('job.process.failed', error, { jobId: job.id });
    } finally {
      // 처리 완료시 제거
      this.processingSet.delete(job.id);
    }
  }

  private async completeJob(claimedJob: Job) {
    await this.mutexManager.run(claimedJob.id, async () => {
      const { idx, job } = await this.jobsSVC.getJob(claimedJob.id);
      // 선점한 후 버전이 바뀐 경우 종료 (pending -> canceled -> waiting -> property -> ...)
      if (job.version !== claimedJob.version) {
        this.logger.warn('job.complete.stale', {
          jobId: job.id,
          claimed: claimedJob.version,
          current: job.version,
          status: job.status,
        });
        await this.recoverSVC.removeRecover(job.id);
        return;
      }
      // 버전이 같으면 무조건 pending
      await this.jobsSVC.updateJob(idx, job, {
        status: JobStatus.completed,
      });

      await this.recoverSVC.removeRecover(job.id);
      this.logger.log('job.completed', { jobId: job.id });
    });
  }

  private async getClaimJob(id: string) {
    return this.mutexManager.run<Job | null>(id, async () => {
      // pending => canceled => waiting 케이스 중복 처리 방지
      if (this.processingSet.has(id)) return null;

      // TODO reservation 처리 위해서 조회 query 추가
      const { idx, job } = await this.jobsSVC.getJob(id);

      if (job.status !== JobStatus.waiting) return null;

      await this.recoverSVC.genRecover(job);

      const updatedJob = await this.jobsSVC.updateJob(idx, job, {
        status: JobStatus.pending,
      });

      this.logger.log('job.claimed', {
        jobId: job.id,
        processingTime: job.processingTime,
      });

      this.processingSet.add(id);
      return updatedJob;
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

  @Cron('*/1 * * * * *', {
    // getClaimJob 순회 완료되지 않은 경우 틱 중지
    waitForCompletion: true,
  })
  async consume() {
    // 멀티 인스턴스일 때 메인 인스턴스만 스케쥴러 돌도록
    if (!this.isPrimary) return;
    // 리커버 완료시 틱 돌도록
    if (!this.isRecovered) return;

    const claimJob = await this.claimJob();

    if (!claimJob) {
      return;
    }

    // fire-and-forget
    void this.processJob(claimJob);
  }
}
