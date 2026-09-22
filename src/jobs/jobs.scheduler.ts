import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { AppLogger } from '../logger/app-logger.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JOB_RECOVER_STATUS_TRANSITIONS } from './jobs.constants.js';
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

          const toStatus = JOB_RECOVER_STATUS_TRANSITIONS[job.status];
          if (!toStatus) {
            await this.recoverSVC.removeRecover(job.id);

            this.logger.warn('job.recovered.cleanup', {
              jobId: recoverJob.id,
              from: job.status,
            });
            return;
          }

          // pending 상태일 경우 waiting으로 원본 복구
          // cancel 상태일 경우 원본 복구 후 canceled 유지
          const recoverJobWithoutId = this.jobsSVC.omitMeta(recoverJob);
          await this.jobsSVC.updateJob(idx, job, {
            ...recoverJobWithoutId,
            status: toStatus,
          });

          await this.recoverSVC.removeRecover(job.id);
          this.logger.log('job.recovered', {
            jobId: recoverJob.id,
            from: job.status,
            to: toStatus,
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

  private async completeJob(completedJob: Job) {
    await this.mutexManager.run(completedJob.id, async () => {
      const { idx, job } = await this.jobsSVC.getJob(completedJob.id);
      // pending 작업의 경우 완료 처리
      if (job.status === JobStatus.pending) {
        await this.jobsSVC.updateJob(idx, job, {
          status: JobStatus.completed,
        });

        await this.recoverSVC.removeRecover(job.id);
        this.logger.log('job.completed', { jobId: job.id });
        return;
      }

      // canceled 작업의 경우 원본 복구 후 canceled 유지
      if (job.status === JobStatus.canceled) {
        const recoverJob = await this.recoverSVC.getRecover(job.id);
        if (!recoverJob) {
          this.logger.error('job.recover.missing', undefined, {
            jobId: job.id,
          });
          return;
        }
        const recoverJobWithoutId = this.jobsSVC.omitMeta(recoverJob);
        await this.jobsSVC.updateJob(idx, job, {
          ...recoverJobWithoutId,
          status: JobStatus.canceled,
        });

        await this.recoverSVC.removeRecover(job.id);
        this.logger.log('job.canceled.restored', { jobId: job.id });
        return;
      }

      // 처리 중에 상태가 또 바뀐 경우 (예: 취소 후 재대기) 아무것도 커밋하지 않는다
      this.logger.warn('job.complete.skipped', {
        jobId: job.id,
        status: job.status,
      });
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
