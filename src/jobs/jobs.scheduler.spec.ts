import { mkdtempSync, rmSync } from 'fs';
import { Config, JsonDB } from 'node-json-db';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JobsScheduler } from './jobs.scheduler.js';
import { JobsService } from './jobs.service.js';
import { RecoverJobService } from './recover-job/recover-job.service.js';
import { Job, JobStatus } from './types/jobs.types.js';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'jobs-scheduler-spec-'));
let seq = 0;

// 선점 직후 상태를 확인할 여유는 있으면서, 테스트가 끝나기 전에 처리가 끝나는 길이
const PROCESSING_SEC = 0.15;

const job = (override: Partial<Job> = {}): Job => ({
  id: 'a',
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

    jobsSVC = new JobsService(runtimeSVC, mutexManager);
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
    );
    // 앱 부팅이 끝난 뒤에야 tick 이 돈다
    await scheduler.onApplicationBootstrap();
  });

  afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  describe('부팅 리커버리', () => {
    it('중단된 pending job 을 recover 원본으로 되돌리고 recover 데이터를 지운다', async () => {
      // 처리 중 서버가 죽어 pending 으로 남고, 값까지 바뀐 상태
      await seed([
        job({ id: 'a', title: '변경된 제목', status: JobStatus.pending }),
        job({ id: 'b', status: JobStatus.waiting }),
      ]);
      await recoverSVC.genRecover(job({ id: 'a', title: '원본 제목' }));

      const booting = new JobsScheduler(
        runtimeSVC,
        jobsSVC,
        recoverSVC,
        mutexManager,
      );

      // 리커버리 전에는 tick 이 돌지 않는다
      expect(booting.isRecovered).toBe(false);
      await booting.consume();
      expect(await statusOf('b')).toBe(JobStatus.waiting);

      await booting.onApplicationBootstrap();

      expect(await jobOf('a')).toEqual(job({ id: 'a', title: '원본 제목' }));
      expect(await recoverSVC.getRecover('a')).toBeNull();
      expect(booting.isRecovered).toBe(true);
    });

    it('recover 데이터가 없는 pending job 은 건너뛴다', async () => {
      await seed([job({ id: 'a', status: JobStatus.pending })]);

      const booting = new JobsScheduler(
        runtimeSVC,
        jobsSVC,
        recoverSVC,
        mutexManager,
      );
      const originalConsoleError = console.error;
      console.error = () => {};

      try {
        await booting.onApplicationBootstrap();
      } finally {
        console.error = originalConsoleError;
      }

      // 복구할 원본이 없으므로 pending 그대로 둔다
      expect(await statusOf('a')).toBe(JobStatus.pending);
      expect(booting.isRecovered).toBe(true);
    });
  });

  describe('선점 / 처리', () => {
    it('선점 시 recover 원본을 남기고, 완료되면 recover 를 지운다', async () => {
      await seed([job()]);

      // consume 은 처리 완료를 기다리지 않는다 (fire-and-forget)
      await scheduler.consume();
      expect(await statusOf()).toBe(JobStatus.pending);
      expect(await recoverSVC.getRecover('a')).toEqual(job());

      await done();
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });

    it('한 번에 하나만 선점한다', async () => {
      await seed([job({ id: 'a' }), job({ id: 'b' })]);

      await scheduler.consume();

      expect(await statusOf('a')).toBe(JobStatus.pending);
      expect(await statusOf('b')).toBe(JobStatus.waiting);
      expect(await recoverSVC.getRecover('b')).toBeNull();

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

    it('처리 중에 취소되면 completed 로 덮어쓰지 않는다', async () => {
      await seed([job()]);

      await scheduler.consume();
      await jobsSVC.editJobStatus('a', JobStatus.canceled);

      await new Promise((resolve) =>
        setTimeout(resolve, PROCESSING_SEC * 1000 + 100),
      );
      expect(await statusOf()).toBe(JobStatus.canceled);
      // 취소로 완료 처리를 건너뛰어도 recover 찌꺼기는 정리된다
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });
  });
});
