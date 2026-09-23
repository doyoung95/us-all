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
    // 복구 여부는 status 가 아니라 version 으로 판단한다.
    // recover 는 선점 이전 스냅샷이고 선점이 version 을 1 올리므로,
    // "현재 version === 스냅샷 + 1" 이면 선점 직후 그대로 죽은 것이다
    it('선점 직후 죽은 job 은 waiting 으로 되돌린다', async () => {
      await seed([job({ version: 2, status: JobStatus.pending })]);
      await recoverSVC.genRecover(job());

      await newScheduler().onApplicationBootstrap();

      // status 만 되돌리고 version 은 되돌리지 않고 1 올린다
      expect(await jobOf()).toEqual(
        job({ version: 3, status: JobStatus.waiting }),
      );
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });

    // 선점 이후 뭐라도 쓰였으면 version 이 스냅샷 + 1 을 넘어간다.
    // 스냅샷으로 되돌리면 그 쓰기를 지우므로 job 은 그대로 두고 recover 만 버린다
    it.each([
      ['취소된', job({ version: 3, status: JobStatus.canceled })],
      ['완료된', job({ version: 3, status: JobStatus.completed })],
      // genRecover 직후 선점 쓰기 전에 죽으면 version 이 스냅샷과 같다
      ['선점 전에 죽어 recover 만 남은', job()],
    ])(
      '%s job 은 되돌리지 않고 찌꺼기 recover 만 지운다',
      async (_, current) => {
        await seed([current]);
        await recoverSVC.genRecover(job());

        await newScheduler().onApplicationBootstrap();

        expect(await jobOf()).toEqual(current);
        expect(await recoverSVC.getRecover('a')).toBeNull();
      },
    );

    it('선점 이후 수정된 job 은 재기동해도 수정 내용이 유지된다', async () => {
      // 선점(2) → 취소(3) → 사용자 수정(4) 까지 간 상태에서 프로세스가 죽은 디스크
      await seed([
        job({
          version: 4,
          title: '사용자가 고친 제목',
          status: JobStatus.canceled,
        }),
      ]);
      await recoverSVC.genRecover(job({ title: '원래 제목' }));

      await newScheduler().onApplicationBootstrap();

      // 스냅샷을 그대로 덮어쓰면 200 으로 확정됐던 수정이 재기동 때 사라진다
      expect(await jobOf()).toEqual(
        job({
          version: 4,
          title: '사용자가 고친 제목',
          status: JobStatus.canceled,
        }),
      );
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });

    it('복구된 job 은 이전 version 으로 수정할 수 없다', async () => {
      await seed([job({ version: 2, status: JobStatus.pending })]);
      await recoverSVC.genRecover(job());

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
      // 선점이 version 을 올리므로 pending 은 스냅샷(1) + 1 인 2 여야 한다
      await seed([job({ id: 'b', version: 2, status: JobStatus.pending })]);
      // 'a' 는 job 이 지워져 복구할 대상이 없는 찌꺼기
      await recoverSVC.genRecover(job({ id: 'a' }));
      await recoverSVC.genRecover(job({ id: 'b' }));

      const booting = newScheduler();
      await booting.onApplicationBootstrap();

      expect(await jobOf('b')).toEqual(
        job({ id: 'b', version: 3, status: JobStatus.waiting }),
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

    it('처리 중에 취소되면 워커가 아무것도 커밋하지 않는다', async () => {
      await seed([job()]);

      await scheduler.consume();
      // 선점으로 version 이 2 가 되었으므로 취소도 2 로 요청한다
      await jobsSVC.changeStatusCancel('a', 2);

      await new Promise((resolve) =>
        setTimeout(resolve, PROCESSING_SEC * 1000 + 100),
      );

      // 취소가 version 을 올렸으므로 워커의 선점 version(2) 은 더 이상 유효하지 않다.
      // completed 로 덮지도, 선점 시점 값으로 되돌리지도 않고 취소 결과(3)에서 멈춘다
      expect(await jobOf()).toEqual(
        job({ version: 3, status: JobStatus.canceled }),
      );
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });

    it('처리 중 취소 후 수정한 내용을 낡은 워커가 되돌리지 않는다', async () => {
      await seed([job({ title: '원래 제목' })]);

      await scheduler.consume();
      await jobsSVC.changeStatusCancel('a', 2);

      // canceled 는 수정이 허용된 상태다 (editJobProperty 가 막는 건 pending / completed)
      const edited = await jobsSVC.editJobProperty('a', {
        version: 3,
        title: '사용자가 고친 제목',
      });
      expect(edited).toMatchObject({ title: '사용자가 고친 제목', version: 4 });

      // 선점 시점 스냅샷을 그대로 덮어쓰면 여기서 수정이 사라진다
      await new Promise((resolve) =>
        setTimeout(resolve, PROCESSING_SEC * 1000 + 100),
      );

      expect(await jobOf()).toEqual(
        job({
          version: 4,
          title: '사용자가 고친 제목',
          status: JobStatus.canceled,
        }),
      );
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });
  });

  describe('중복 선점 방지', () => {
    // 취소 후 재대기는 허용된 전이라 status 만으로는 "워커가 도는 중" 을 알 수 없다.
    // 그래서 선점한 id 를 인메모리로 들고 있다가 처리가 끝날 때 놓아준다
    const cancelAndWait = async () => {
      await jobsSVC.changeStatusCancel('a', 2);
      await jobsSVC.changeStatusWait('a', 3);
    };

    it('워커가 도는 동안에는 같은 job 을 다시 선점하지 않는다', async () => {
      // 취소/재대기 왕복이 끝날 때까지 워커가 살아 있어야 하는 테스트다
      await seed([job({ processingTime: 1 })]);

      await scheduler.consume();
      await cancelAndWait();
      expect(await statusOf()).toBe(JobStatus.waiting);

      // waiting 이지만 아직 처리 중이므로 틱이 집어가면 안 된다
      await scheduler.consume();

      expect(await jobOf()).toEqual(
        job({ version: 4, processingTime: 1, status: JobStatus.waiting }),
      );
      // 선점이 없었으니 recover 도 선점 이전(version 1) 원본 그대로다
      expect(await recoverSVC.getRecover('a')).toEqual(
        job({ processingTime: 1 }),
      );
    });

    it('워커가 끝나면 다시 선점되어 완료까지 간다', async () => {
      await seed([job()]);

      await scheduler.consume();
      await cancelAndWait();

      // 처리가 끝나 id 가 풀릴 때까지 틱을 계속 돌린다.
      // 여기서 풀어주지 않으면 job 은 waiting 그대로 영구히 멈춘다
      await waitFor(async () => {
        await scheduler.consume();
        return (await statusOf()) === JobStatus.pending;
      });

      // 취소/재대기(3,4) 다음 재선점이라 version 은 5 부터 이어진다
      expect(await jobOf()).toEqual(
        job({ version: 5, status: JobStatus.pending }),
      );

      await done();
      expect(await jobOf()).toEqual(
        job({ version: 6, status: JobStatus.completed }),
      );
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });

    it('취소 후 재대기했으면 낡은 워커가 완료로 덮지 않는다', async () => {
      await seed([job()]);

      await scheduler.consume();
      await cancelAndWait();

      // 1차 워커가 끝나는 시점을 지나도 completed 로 넘어가지 않는다
      await new Promise((resolve) =>
        setTimeout(resolve, PROCESSING_SEC * 1000 + 100),
      );

      expect(await jobOf()).toEqual(
        job({ version: 4, status: JobStatus.waiting }),
      );
    });
  });

  describe('동시 실행 상한', () => {
    // 처리는 fire-and-forget 이라 선점 속도(틱당 1건)만으로는 동시 실행 개수가
    // 묶이지 않는다. 상한은 처리 중인 id 집합의 크기로 건다
    const setConcurrency = (value: number) => {
      (scheduler as unknown as { concurrency: number }).concurrency = value;
    };

    it('상한에 도달하면 틱이 돌아도 더 선점하지 않는다', async () => {
      setConcurrency(2);
      // 단정하는 동안 슬롯이 비지 않도록 처리 시간을 넉넉히 준다
      const jobs = ['a', 'b', 'c'].map((id) =>
        job({ id, processingTime: 0.5 }),
      );
      await seed(jobs);

      // 상한보다 많이 돌려도 pending 은 상한만큼만 늘어난다
      for (let i = 0; i < 4; i++) {
        await scheduler.consume();
      }

      expect(await statusOf('a')).toBe(JobStatus.pending);
      expect(await statusOf('b')).toBe(JobStatus.pending);
      expect(await statusOf('c')).toBe(JobStatus.waiting);
      // 선점되지 않았으니 recover 도 남지 않는다
      expect(await recoverSVC.getRecover('c')).toBeNull();

      // 남은 워커가 다음 테스트로 새어나가지 않게 비운다
      await done('a');
      await done('b');
    });

    it('처리가 끝나 슬롯이 비면 다시 선점한다', async () => {
      setConcurrency(1);
      await seed([job({ id: 'a' }), job({ id: 'b' })]);

      await scheduler.consume();
      expect(await statusOf('a')).toBe(JobStatus.pending);

      // a 가 끝나기 전에는 상한에 걸려 b 를 잡지 않는다
      await scheduler.consume();
      expect(await statusOf('b')).toBe(JobStatus.waiting);

      // done 은 DB 에 completed 가 보이면 반환하는데, 슬롯 해제(processingSet)는
      // 그 직후 finally 에서 일어난다. 해제될 때까지 틱을 계속 돌린다
      await done('a');
      await waitFor(async () => {
        await scheduler.consume();
        return (await statusOf('b')) === JobStatus.pending;
      });

      await done('b');
    });
  });

  describe('처리 실패 복구', () => {
    // process() 는 setTimeout 이라 실패하지 않는다.
    // 완료 커밋을 실패시켜 processJob 의 catch 경로를 태운다.
    // 쓰기 전에 실패하면 version 이 그대로이고, 쓴 뒤에 실패하면 version 이 올라간다
    const failCompleteWrite = (when: 'before' | 'after') => {
      const origin = jobsSVC.updateJob.bind(jobsSVC);
      jobsSVC.updateJob = async (idx, current, patchData) => {
        if (patchData.status !== JobStatus.completed) {
          return origin(idx, current, patchData);
        }
        if (when === 'after') await origin(idx, current, patchData);
        throw new Error('완료 처리 실패');
      };
    };

    it('처리 중 실패하면 waiting 으로 되돌리고 recover 를 지운다', async () => {
      await seed([job()]);
      failCompleteWrite('before');

      await scheduler.consume();
      expect(await statusOf()).toBe(JobStatus.pending);

      // 실패하면 pending 에 갇히지 않고 다시 대기열로 돌아와야 한다
      await waitFor(async () => (await statusOf()) === JobStatus.waiting);

      // 선점(2) → 실패 복구(3). 값은 그대로 두고 status 만 되돌린다
      expect(await jobOf()).toEqual(
        job({ version: 3, status: JobStatus.waiting }),
      );
      expect(await recoverSVC.getRecover('a')).toBeNull();
    });

    it('완료가 이미 쓰인 뒤 실패했으면 되돌리지 않는다', async () => {
      await seed([job()]);
      // 완료 커밋은 성공했는데 그 뒤 후속 처리에서 실패한 상황
      failCompleteWrite('after');

      await scheduler.consume();
      await new Promise((resolve) =>
        setTimeout(resolve, PROCESSING_SEC * 1000 + 100),
      );

      // 완료 쓰기가 version 을 올렸으므로 워커의 선점 티켓은 이미 무효다.
      // 여기서 waiting 으로 되돌리면 끝난 작업이 되살아나 다시 처리된다
      expect(await jobOf()).toEqual(
        job({ version: 3, status: JobStatus.completed }),
      );
    });
  });
});
