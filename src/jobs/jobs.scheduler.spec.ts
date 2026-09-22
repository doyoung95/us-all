import { ConflictException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { Config, JsonDB } from 'node-json-db';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { AppLogger } from '../logger/app-logger.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JobsScheduler } from './jobs.scheduler.js';
import { JobsService } from './jobs.service.js';
import { RecoverJobService } from './recover-job/recover-job.service.js';
import { Job, JobStatus } from './types/jobs.types.js';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'jobs-scheduler-spec-'));
let seq = 0;

// 실제 logs.txt 를 건드리지 않도록 임시 파일로 돌린다
process.env.LOG_FILE = join(TMP_DIR, 'logs.txt');
const logger = new AppLogger();

// 선점 직후 상태를 확인할 여유는 있으면서, 테스트가 끝나기 전에 처리가 끝나는 길이
const PROCESSING_SEC = 0.15;

const job = (override: Partial<Job> = {}): Job => ({
  id: 'a',
  version: 1,
  title: '작업',
  status: JobStatus.waiting,
  reservationTime: 0,
  processingTime: PROCESSING_SEC,
  ...override,
});

const tmpDB = () =>
  new JsonDB(new Config(join(TMP_DIR, `db-${seq++}`), true, false, '/'));

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 2000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: 시간 내에 조건이 만족되지 않았습니다.');
};

describe('JobsScheduler', () => {
  let scheduler: JobsScheduler;
  let jobsSVC: JobsService;
  let recoverSVC: RecoverJobService;
  let runtimeSVC: RuntimeService;
  let mutexManager: MutexManager;
  let db: JsonDB;

  const seed = (jobs: Job[]) => db.push('/list', jobs);
  const statusOf = async (id = 'a') =>
    ((await db.getData('/list')) as Job[]).find((item) => item.id === id)
      ?.status;
  const jobOf = async (id = 'a') =>
    ((await db.getData('/list')) as Job[]).find((item) => item.id === id);
  const done = (id = 'a') =>
    waitFor(async () => (await statusOf(id)) === JobStatus.completed);

  beforeEach(async () => {
    runtimeSVC = { getRunningSec: () => 0 } as RuntimeService;
    // 모듈 설정과 동일하게 service / scheduler 가 같은 MutexManager 를 공유한다
    mutexManager = new MutexManager();

    jobsSVC = new JobsService(runtimeSVC, mutexManager, logger);
    db = tmpDB();
    (jobsSVC as unknown as { db: JsonDB }).db = db;
    await jobsSVC.onModuleInit();

    recoverSVC = new RecoverJobService();
    (recoverSVC as unknown as { db: JsonDB }).db = tmpDB();
    await recoverSVC.onModuleInit();

    scheduler = new JobsScheduler(
      runtimeSVC,
      jobsSVC,
      recoverSVC,
      mutexManager,
      logger,
    );
    // 앱 부팅이 끝난 뒤에야 tick 이 돈다
    await scheduler.onApplicationBootstrap();
  });

  afterAll(async () => {
    await logger.close();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  const newScheduler = () =>
    new JobsScheduler(runtimeSVC, jobsSVC, recoverSVC, mutexManager, logger);

  describe('부팅 리커버리', () => {
    // JOB_RECOVER_STATUS_TRANSITIONS 기준 (null = 복구 대상 아님)
    it.each([
      [JobStatus.pending, JobStatus.waiting],
      [JobStatus.canceled, JobStatus.canceled],
      [JobStatus.waiting, null],
      [JobStatus.completed, null],
    ])('%s 상태의 job 은 %s 로 복구된다', async (from, to) => {
      await seed([job({ version: 2, title: '변경된 제목', status: from })]);
      await recoverSVC.genRecover(job({ title: '원본 제목' }));

      await newScheduler().onApplicationBootstrap();

      if (!to) {
        // 복구 대상이 아니면 job 은 그대로 두고 찌꺼기 recover 만 정리한다
        expect(await jobOf()).toEqual(
          job({ version: 2, title: '변경된 제목', status: from }),
        );
        expect(await recoverSVC.getRecover('a')).toBeNull();
        return;
      }

      // 원본 값으로 되돌리되 version 은 되돌리지 않고 1 올린다
      expect(await jobOf()).toEqual(
        job({ version: 3, title: '원본 제목', status: to }),
      );
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });

    it('복구된 job 은 이전 version 으로 수정할 수 없다', async () => {
      await seed([
        job({ version: 2, title: '변경된 제목', status: JobStatus.pending }),
      ]);
      await recoverSVC.genRecover(job({ title: '원본 제목' }));

      await newScheduler().onApplicationBootstrap();

      // 복구 전 version(2) 을 들고 있던 요청은 거절된다
      await expect(
        jobsSVC.editJobProperty('a', { version: 2, title: '새 제목' }),
      ).rejects.toBeInstanceOf(ConflictException);

      const edited = await jobsSVC.editJobProperty('a', {
        version: 3,
        title: '새 제목',
      });
      expect(edited.version).toBe(4);
    });

    it('리커버리가 끝나기 전에는 tick 이 돌지 않는다', async () => {
      await seed([job()]);
      const booting = newScheduler();

      expect(booting.isRecovered).toBe(false);
      await booting.consume();
      expect(await statusOf()).toBe(JobStatus.waiting);

      await booting.onApplicationBootstrap();
      expect(booting.isRecovered).toBe(true);
    });

    it('job 이 없는 recover 데이터는 건너뛰고 나머지를 복구한다', async () => {
      await seed([job({ id: 'b', status: JobStatus.pending })]);
      // 'a' 는 job 이 지워져 복구할 대상이 없는 찌꺼기
      await recoverSVC.genRecover(job({ id: 'a' }));
      await recoverSVC.genRecover(job({ id: 'b', title: '원본 제목' }));

      const booting = newScheduler();
      await booting.onApplicationBootstrap();

      expect(await jobOf('b')).toEqual(
        job({
          id: 'b',
          version: 2,
          title: '원본 제목',
          status: JobStatus.waiting,
        }),
      );
      expect(await recoverSVC.getRecover('b')).toBeNull();
      expect(booting.isRecovered).toBe(true);
    });
  });

  describe('선점 / 처리', () => {
    it('선점 시 recover 원본을 남기고, 완료되면 recover 를 지운다', async () => {
      await seed([job()]);

      // consume 은 처리 완료를 기다리지 않는다 (fire-and-forget)
      await scheduler.consume();
      expect(await statusOf()).toBe(JobStatus.pending);
      // recover 에는 선점 이전(version 1) 원본이 그대로 들어간다
      expect(await recoverSVC.getRecover('a')).toEqual(job());

      await done();
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });

    it('선점과 완료가 각각 version 을 1 씩 올린다', async () => {
      await seed([job()]);

      await scheduler.consume();
      expect(await jobOf()).toEqual(
        job({ version: 2, status: JobStatus.pending }),
      );

      await done();
      expect(await jobOf()).toEqual(
        job({ version: 3, status: JobStatus.completed }),
      );
    });

    it('선점되면 선점 이전 version 으로는 취소할 수 없다', async () => {
      await seed([job()]);

      await scheduler.consume();

      await expect(jobsSVC.changeStatusCancel('a', 1)).rejects.toBeInstanceOf(
        ConflictException,
      );

      await done();
    });

    it('한 번에 하나만 선점한다', async () => {
      await seed([job({ id: 'a' }), job({ id: 'b' })]);

      await scheduler.consume();

      expect(await statusOf('a')).toBe(JobStatus.pending);
      expect(await statusOf('b')).toBe(JobStatus.waiting);
      expect(await recoverSVC.getRecover('b')).toBeNull();
      // 선점되지 않은 job 의 version 은 그대로다
      expect(await jobOf('b')).toEqual(job({ id: 'b' }));

      await done('a');
    });

    it('waiting 이 없으면 아무 상태도 바뀌지 않는다', async () => {
      const jobs = [
        job({ id: 'a', status: JobStatus.pending }),
        job({ id: 'b', status: JobStatus.canceled }),
        job({ id: 'c', status: JobStatus.completed }),
      ];
      await seed(jobs);

      await scheduler.consume();

      expect(await db.getData('/list')).toEqual(jobs);
    });

    it('처리 중에 취소되면 원본을 복구하고 canceled 를 유지한다', async () => {
      await seed([job()]);

      await scheduler.consume();
      // 선점으로 version 이 2 가 되었으므로 취소도 2 로 요청한다
      await jobsSVC.changeStatusCancel('a', 2);

      await new Promise((resolve) =>
        setTimeout(resolve, PROCESSING_SEC * 1000 + 100),
      );

      // completed 로 덮어쓰지 않고, 원본 값으로 되돌린 뒤 canceled 유지
      // version 은 선점(2) / 취소(3) / 원본 복구(4) 로 계속 올라간다
      expect(await jobOf()).toEqual(
        job({ version: 4, status: JobStatus.canceled }),
      );
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });
  });
});
