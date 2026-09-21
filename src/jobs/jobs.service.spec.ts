import { ConflictException, NotFoundException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { Config, JsonDB } from 'node-json-db';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JobsService } from './jobs.service.js';
import { Job, JobStatus } from './types/jobs.types.js';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'jobs-service-spec-'));
let seq = 0;

const job = (override: Partial<Job> = {}): Job => ({
  id: 'job-1',
  title: '작업 1',
  description: '설명 1',
  status: JobStatus.waiting,
  reservationTime: 3,
  processingTime: 5,
  ...override,
});

describe('JobsService', () => {
  const RUNNING_SEC = 10;

  let service: JobsService;
  let mutexManager: MutexManager;
  let db: JsonDB;

  const seed = async (jobs: Job[]) => {
    await db.push('/list', jobs);
  };
  const list = () => db.getData('/list') as Promise<Job[]>;

  beforeEach(async () => {
    mutexManager = new MutexManager();
    const runtimeSVC = {
      getRunningSec: () => RUNNING_SEC,
    } as RuntimeService;

    service = new JobsService(runtimeSVC, mutexManager);

    // 실제 data/jobs.json 대신 테스트마다 새로운 임시 파일을 사용한다.
    db = new JsonDB(new Config(join(TMP_DIR, `db-${seq++}`), true, false, '/'));
    (service as unknown as { db: JsonDB }).db = db;

    await service.onModuleInit();
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('create', () => {
    it('waiting 상태의 job 을 추가한다', async () => {
      await service.create({ title: '새 작업', description: '설명' });

      const [created] = await list();
      expect(created.id).toEqual(expect.any(String));
      expect(created.title).toBe('새 작업');
      expect(created.description).toBe('설명');
      expect(created.status).toBe(JobStatus.waiting);

      // processingTime: random(1, 20)
      expect(created.processingTime).toBeGreaterThanOrEqual(1);
      expect(created.processingTime).toBeLessThanOrEqual(20);
      // reservationTime: random(1, 20) + 서버 구동 시간
      expect(created.reservationTime).toBeGreaterThanOrEqual(1 + RUNNING_SEC);
      expect(created.reservationTime).toBeLessThanOrEqual(20 + RUNNING_SEC);
    });
  });

  describe('getJobs / searchJobs', () => {
    const waiting = job({
      id: 'a',
      title: '리포트 작성',
      status: JobStatus.waiting,
    });
    const pending = job({
      id: 'b',
      title: '리포트 검토',
      status: JobStatus.pending,
    });
    const completed = job({
      id: 'c',
      title: '배포',
      status: JobStatus.completed,
    });

    beforeEach(async () => {
      await seed([waiting, pending, completed]);
    });

    it('getJobs 는 전체 목록을 반환한다', async () => {
      expect(await service.getJobs()).toEqual([waiting, pending, completed]);
    });

    it('조건이 없으면 전체를 반환한다', async () => {
      expect(await service.searchJobs({})).toEqual([
        waiting,
        pending,
        completed,
      ]);
    });

    it('title 은 부분 일치로 검색한다', async () => {
      expect(await service.searchJobs({ title: '리포트' })).toEqual([
        waiting,
        pending,
      ]);
    });

    it('status 로 검색한다', async () => {
      expect(await service.searchJobs({ status: JobStatus.completed })).toEqual(
        [completed],
      );
    });

    it('일치하는 항목이 없으면 빈 배열을 반환한다', async () => {
      expect(await service.searchJobs({ title: '없는작업' })).toEqual([]);
    });
  });

  describe('getJob', () => {
    it('id 로 job 과 인덱스를 반환한다', async () => {
      await seed([job({ id: 'a' }), job({ id: 'b' })]);

      expect(await service.getJob('b')).toEqual({
        idx: 1,
        job: job({ id: 'b' }),
      });
    });

    it('존재하지 않으면 NotFoundException 을 던진다', async () => {
      await seed([job({ id: 'a' })]);

      await expect(service.getJob('none')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('editStatusById / editStatusByIdx', () => {
    beforeEach(async () => {
      await seed([job({ id: 'a' }), job({ id: 'b' })]);
    });

    it('id 로 상태만 변경한다', async () => {
      await service.editStatusById('b', JobStatus.completed);

      const jobs = await list();
      expect(jobs[1]).toEqual(job({ id: 'b', status: JobStatus.completed }));
      expect(jobs[0].status).toBe(JobStatus.waiting);
    });

    it('id 가 없으면 NotFoundException 을 던진다', async () => {
      await expect(
        service.editStatusById('none', JobStatus.completed),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('idx 로 상태만 변경한다', async () => {
      await service.editStatusByIdx(0, JobStatus.pending);

      expect((await list())[0]).toEqual(
        job({ id: 'a', status: JobStatus.pending }),
      );
    });
  });

  describe('editJobProperty', () => {
    it('전달된 필드만 수정한다', async () => {
      await seed([job({ id: 'a' })]);

      await service.editJobProperty('a', { title: '수정된 제목' });

      expect((await list())[0]).toEqual(job({ id: 'a', title: '수정된 제목' }));
    });

    it('undefined 인 필드는 기존 값을 유지한다', async () => {
      await seed([job({ id: 'a' })]);

      await service.editJobProperty('a', {
        title: undefined,
        description: '수정된 설명',
      });

      expect((await list())[0]).toEqual(
        job({ id: 'a', description: '수정된 설명' }),
      );
    });

    it('completed 상태면 ConflictException 을 던진다', async () => {
      await seed([job({ id: 'a', status: JobStatus.completed })]);

      await expect(
        service.editJobProperty('a', { title: 'x' }),
      ).rejects.toThrow(ConflictException);
      expect((await list())[0].title).toBe('작업 1');
    });

    it('pending 상태면 ConflictException 을 던진다', async () => {
      await seed([job({ id: 'a', status: JobStatus.pending })]);

      await expect(
        service.editJobProperty('a', { title: 'x' }),
      ).rejects.toThrow(ConflictException);
    });

    it('canceled 상태는 수정할 수 있다', async () => {
      await seed([job({ id: 'a', status: JobStatus.canceled })]);

      await service.editJobProperty('a', { title: '수정됨' });

      expect((await list())[0].title).toBe('수정됨');
    });

    it('id 가 없으면 NotFoundException 을 던진다', async () => {
      await seed([job({ id: 'a' })]);

      await expect(
        service.editJobProperty('none', { title: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('editJobStatus', () => {
    it('허용된 전이는 반영된다', async () => {
      await seed([job({ id: 'a', status: JobStatus.waiting })]);

      await service.editJobStatus('a', JobStatus.canceled);

      expect((await list())[0].status).toBe(JobStatus.canceled);
    });

    it('pending -> canceled 도 허용된다', async () => {
      await seed([job({ id: 'a', status: JobStatus.pending })]);

      await service.editJobStatus('a', JobStatus.canceled);

      expect((await list())[0].status).toBe(JobStatus.canceled);
    });

    it('허용되지 않은 전이는 ConflictException 을 던지고 상태를 바꾸지 않는다', async () => {
      await seed([job({ id: 'a', status: JobStatus.waiting })]);

      await expect(
        service.editJobStatus('a', JobStatus.completed),
      ).rejects.toBeInstanceOf(ConflictException);
      expect((await list())[0].status).toBe(JobStatus.waiting);
    });

    it('completed 에서는 어떤 상태로도 전이할 수 없다', async () => {
      await seed([job({ id: 'a', status: JobStatus.completed })]);

      await expect(
        service.editJobStatus('a', JobStatus.waiting),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('job id 를 키로 mutex 를 잡는다', async () => {
      await seed([job({ id: 'a' })]);
      const keys: string[] = [];
      const originalRun = mutexManager.run.bind(mutexManager);
      mutexManager.run = (key, cb) => {
        keys.push(key);
        return originalRun(key, cb);
      };

      await service.editJobStatus('a', JobStatus.canceled);

      expect(keys).toEqual(['a']);
    });

    it('동시 요청은 직렬화되어 두 번째 요청이 최신 상태를 검증한다', async () => {
      await seed([job({ id: 'a', status: JobStatus.waiting })]);

      const results = await Promise.allSettled([
        service.editJobStatus('a', JobStatus.canceled),
        service.editJobStatus('a', JobStatus.canceled),
      ]);

      expect(results[0].status).toBe('fulfilled');
      // 이미 canceled 이므로 canceled -> canceled 전이는 거부된다
      expect(results[1].status).toBe('rejected');
      expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
      expect((await list())[0].status).toBe(JobStatus.canceled);
    });

    it('예외가 발생해도 락이 해제되어 다음 요청이 처리된다', async () => {
      await seed([job({ id: 'a', status: JobStatus.waiting })]);

      await expect(
        service.editJobStatus('a', JobStatus.completed),
      ).rejects.toBeInstanceOf(ConflictException);
      await service.editJobStatus('a', JobStatus.canceled);

      expect((await list())[0].status).toBe(JobStatus.canceled);
    });
  });
});
