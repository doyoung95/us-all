import { ConflictException, NotFoundException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { Config, JsonDB } from 'node-json-db';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { AppLogger } from '../logger/app-logger.service.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JobsService } from './jobs.service.js';
import { Job, JobStatus } from './types/jobs.types.js';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'jobs-service-spec-'));
let seq = 0;

// 실제 logs.txt 를 건드리지 않도록 임시 파일로 돌린다
process.env.LOG_FILE = join(TMP_DIR, 'logs.txt');
const logger = new AppLogger();

const job = (override: Partial<Job> = {}): Job => ({
  id: 'a',
  version: 1,
  title: '작업',
  status: JobStatus.waiting,
  reservationTime: 0,
  processingTime: 1,
  ...override,
});

describe('JobsService', () => {
  let service: JobsService;
  let db: JsonDB;

  const seed = (jobs: Job[]) => db.push('/list', jobs);
  const find = async (id = 'a') =>
    ((await db.getData('/list')) as Job[]).find((item) => item.id === id)!;

  beforeEach(async () => {
    service = new JobsService(
      { getRunningSec: () => 0 } as RuntimeService,
      new MutexManager(),
      logger,
    );
    // 실제 data/jobs.json 대신 테스트마다 새 임시 파일을 쓴다
    db = new JsonDB(new Config(join(TMP_DIR, `db-${seq++}`), true, false, '/'));
    (service as unknown as { db: JsonDB }).db = db;
    await service.onModuleInit();
  });

  afterAll(async () => {
    await logger.close();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('create', () => {
    it('새 job 은 version 1 로 시작한다', async () => {
      const created = await service.create({ title: '작업' });

      expect(created.version).toBe(1);
      expect((await find(created.id)).version).toBe(1);
    });
  });

  describe('updateJob', () => {
    it('전달된 필드만 덮어쓰고 version 을 1 올린다', async () => {
      await seed([job({ version: 3, title: '기존 제목' })]);
      const { idx, job: current } = await service.getJob('a');

      const updated = await service.updateJob(idx, current, {
        status: JobStatus.pending,
      });

      // 반환값과 저장값이 같아야 호출부가 재조회 없이 쓸 수 있다
      expect(updated).toEqual(
        job({ version: 4, title: '기존 제목', status: JobStatus.pending }),
      );
      expect(await find()).toEqual(updated);
    });

    it('연속 호출하면 version 이 계속 증가한다', async () => {
      await seed([job()]);

      for (const expected of [2, 3, 4]) {
        const { idx, job: current } = await service.getJob('a');
        const updated = await service.updateJob(idx, current, {
          title: `제목 ${expected}`,
        });

        expect(updated.version).toBe(expected);
        expect((await find()).version).toBe(expected);
      }
    });
  });

  describe('omitMeta', () => {
    it('id 와 version 을 뺀 나머지 필드만 남긴다', () => {
      const origin = job({ id: 'origin', version: 9, title: '원본 제목' });

      expect(service.omitMeta(origin)).toEqual({
        title: '원본 제목',
        status: JobStatus.waiting,
        reservationTime: 0,
        processingTime: 1,
      });
    });

    it('원본 복구 시 대상 job 의 id/version 은 유지된다', async () => {
      await seed([
        job({ version: 5, title: '변경된 제목', status: JobStatus.pending }),
      ]);
      const { idx, job: current } = await service.getJob('a');
      // 리커버 데이터는 선점 이전 시점이라 version 이 뒤처져 있다
      const recoverJob = job({ version: 1, title: '원본 제목' });

      const restored = await service.updateJob(idx, current, {
        ...service.omitMeta(recoverJob),
        status: JobStatus.waiting,
      });

      expect(restored).toEqual(
        job({ version: 6, title: '원본 제목', status: JobStatus.waiting }),
      );
      expect(await find()).toEqual(restored);
    });
  });

  describe('searchJobs', () => {
    beforeEach(() =>
      seed([
        job({ id: 'a', title: '리포트 작성', status: JobStatus.waiting }),
        job({ id: 'b', title: '리포트 검토', status: JobStatus.pending }),
        job({ id: 'c', title: '배포', status: JobStatus.completed }),
      ]),
    );

    const ids = (jobs: Job[]) => jobs.map((item) => item.id);

    it('조건이 없으면 전체를 반환한다', async () => {
      expect(ids(await service.searchJobs({}))).toEqual(['a', 'b', 'c']);
    });

    it('title 은 부분 일치로 검색한다', async () => {
      expect(ids(await service.searchJobs({ title: '리포트' }))).toEqual([
        'a',
        'b',
      ]);
    });

    it('title 과 status 는 AND 조건이다', async () => {
      const result = await service.searchJobs({
        title: '리포트',
        status: JobStatus.pending,
      });
      expect(ids(result)).toEqual(['b']);
    });
  });

  describe('editJobProperty', () => {
    it.each([JobStatus.waiting, JobStatus.canceled])(
      '%s 상태는 전달된 필드만 수정하고 version 을 올린다',
      async (status) => {
        await seed([job({ status, title: '기존 제목' })]);

        const edited = await service.editJobProperty('a', {
          version: 1,
          title: undefined,
          description: '새 설명',
        });

        // 변경된 job 을 그대로 돌려준다 (컨트롤러 응답 바디가 된다)
        expect(edited).toMatchObject({
          title: '기존 제목',
          description: '새 설명',
          version: 2,
        });
        expect(await find()).toMatchObject({
          title: '기존 제목',
          description: '새 설명',
          version: 2,
        });
      },
    );

    it.each([JobStatus.pending, JobStatus.completed])(
      '%s 상태는 수정할 수 없다',
      async (status) => {
        await seed([job({ status, title: '기존 제목' })]);

        await expect(
          service.editJobProperty('a', { version: 1, title: '새 제목' }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect((await find()).title).toBe('기존 제목');
      },
    );

    it.each([
      ['version 이 뒤처지면', 1],
      ['version 이 앞서면', 3],
    ])('%s 409 이고 아무것도 바뀌지 않는다', async (_, version) => {
      await seed([job({ version: 2, title: '기존 제목' })]);

      await expect(
        service.editJobProperty('a', { version, title: '새 제목' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await find()).toEqual(job({ version: 2, title: '기존 제목' }));
    });

    it('한 번 쓴 version 은 재사용할 수 없다', async () => {
      await seed([job()]);

      await service.editJobProperty('a', { version: 1, title: '첫 번째' });

      // 같은 version 으로 들어온 뒤늦은 요청은 덮어쓰지 못한다
      await expect(
        service.editJobProperty('a', { version: 1, title: '두 번째' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect((await find()).title).toBe('첫 번째');
    });

    it('version 검증은 상태 검증보다 먼저 한다', async () => {
      await seed([job({ version: 2, status: JobStatus.completed })]);

      await expect(
        service.editJobProperty('a', { version: 1, title: '새 제목' }),
      ).rejects.toThrow(/버전이 일치하지 않습니다/);
    });
  });

  describe('changeStatusCancel', () => {
    it.each([
      [JobStatus.waiting, true],
      [JobStatus.pending, true],
      [JobStatus.canceled, false],
      [JobStatus.completed, false],
    ])('%s 상태에서 취소 가능: %s', async (from, allowed) => {
      await seed([job({ status: from })]);

      if (allowed) {
        const changed = await service.changeStatusCancel('a', 1);

        // 변경된 job 을 그대로 돌려준다 (컨트롤러 응답 바디가 된다)
        expect(changed.status).toBe(JobStatus.canceled);
        expect(changed.version).toBe(2);
        expect(await find()).toEqual(
          job({ status: JobStatus.canceled, version: 2 }),
        );
        return;
      }

      await expect(service.changeStatusCancel('a', 1)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect((await find()).status).toBe(from);
    });

    it('version 이 다르면 409 이고 상태도 version 도 그대로다', async () => {
      await seed([job({ version: 2 })]);

      await expect(service.changeStatusCancel('a', 1)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await find()).toEqual(job({ version: 2 }));
    });
  });

  describe('changeStatusWait', () => {
    it.each([
      [JobStatus.canceled, true],
      [JobStatus.waiting, false],
      [JobStatus.pending, false],
      [JobStatus.completed, false],
    ])('%s 상태에서 대기 복구 가능: %s', async (from, allowed) => {
      await seed([job({ status: from })]);

      if (allowed) {
        const changed = await service.changeStatusWait('a', 1);

        expect(changed.status).toBe(JobStatus.waiting);
        expect(changed.version).toBe(2);
        expect(await find()).toEqual(
          job({ status: JobStatus.waiting, version: 2 }),
        );
        return;
      }

      await expect(service.changeStatusWait('a', 1)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect((await find()).status).toBe(from);
    });

    it('version 이 다르면 409 이고 상태도 version 도 그대로다', async () => {
      await seed([job({ status: JobStatus.canceled, version: 2 })]);

      await expect(service.changeStatusWait('a', 1)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await find()).toEqual(
        job({ status: JobStatus.canceled, version: 2 }),
      );
    });
  });

  it('없는 id 를 조회하면 NotFoundException 을 던진다', async () => {
    await seed([job()]);

    await expect(service.getJob('none')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
