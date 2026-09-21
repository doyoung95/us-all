import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JobsService } from './jobs.service.js';
import { JOB_MUTEX_MANAGER } from './jobs.token.js';
import { JobStatus } from './types/jobs.types.js';
import { process } from './util/process.js';

@Injectable()
export class JobsScheduler {
  constructor(
    private readonly runtimeSVC: RuntimeService,
    private readonly jobsSVC: JobsService,
    @Inject(JOB_MUTEX_MANAGER)
    private readonly mutexManager: MutexManager,
  ) {}

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
      console.log('empty');
      return;
    }

    // TODO 락 획득 전 작업 위험 수정 필요
    // 락과 상태값으로 처리 필요
    const job = jobs[0];
    await this.jobsSVC.editStatusById(job.id, JobStatus.pending);
    // fire-and-forget
    this.mutexManager.run(job.id, async () => {
      await process(job.processingTime);
      await this.jobsSVC.editStatusById(job.id, JobStatus.completed);
    });
  }
}
