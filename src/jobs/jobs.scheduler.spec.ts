import { mkdtempSync, rmSync } from 'fs';
import { Config, JsonDB } from 'node-json-db';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JobsScheduler } from './jobs.scheduler.js';
import { JobsService } from './jobs.service.js';
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
  let runtimeSVC: RuntimeService;
  let mutexManager: MutexManager;
  let db: JsonDB;

  const seed = (jobs: Job[]) => db.push('/list', jobs);
  const statusOf = async (id = 'a') =>
    ((await db.getData('/list')) as Job[]).find((item) => item.id === id)
      ?.status;
  const done = (id = 'a') =>
    waitFor(async () => (await statusOf(id)) === JobStatus.completed);

  beforeEach(async () => {
    runtimeSVC = { getRunningSec: () => 0 } as RuntimeService;
    // 모듈 설정과 동일하게 service / scheduler 가 같은 MutexManager 를 공유한다
    mutexManager = new MutexManager();

    jobsSVC = new JobsService(runtimeSVC, mutexManager);
    db = new JsonDB(new Config(join(TMP_DIR, `db-${seq++}`), true, false, '/'));
    (jobsSVC as unknown as { db: JsonDB }).db = db;
    await jobsSVC.onModuleInit();

    scheduler = new JobsScheduler(runtimeSVC, jobsSVC, mutexManager);
    // 앱 부팅이 끝난 뒤에야 tick 이 돈다
    await scheduler.onApplicationBootstrap();
  });

  afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('부팅 시 pending job 을 waiting 으로 되돌린 뒤 tick 을 시작한다', async () => {
    await seed([
      job({ id: 'a', status: JobStatus.pending }),
      job({ id: 'b', status: JobStatus.waiting }),
      job({ id: 'c', status: JobStatus.completed }),
    ]);
    const booting = new JobsScheduler(runtimeSVC, jobsSVC, mutexManager);

    // 리커버리 전에는 tick 이 돌지 않는다
    expect(booting.isRecovered).toBe(false);
    await booting.consume();
    expect(await statusOf('b')).toBe(JobStatus.waiting);

    await booting.onApplicationBootstrap();

    // 중단됐던 pending 만 waiting 으로 원복되고 나머지는 유지된다
    expect(await statusOf('a')).toBe(JobStatus.waiting);
    expect(await statusOf('b')).toBe(JobStatus.waiting);
    expect(await statusOf('c')).toBe(JobStatus.completed);
    expect(booting.isRecovered).toBe(true);
  });

  it('waiting job 을 선점해 pending 으로 바꾸고, 처리 후 completed 가 된다', async () => {
    await seed([job()]);

    // consume 은 처리 완료를 기다리지 않는다 (fire-and-forget)
    await scheduler.consume();
    expect(await statusOf()).toBe(JobStatus.pending);

    await done();
  });

  it('한 번에 하나만 선점한다', async () => {
    await seed([job({ id: 'a' }), job({ id: 'b' })]);

    await scheduler.consume();

    expect(await statusOf('a')).toBe(JobStatus.pending);
    expect(await statusOf('b')).toBe(JobStatus.waiting);

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
  });
});
