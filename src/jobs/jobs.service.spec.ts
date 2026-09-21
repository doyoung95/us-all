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
      '%s 상태는 전달된 필드만 수정한다',
      async (status) => {
        await seed([job({ status, title: '기존 제목' })]);

        const edited = await service.editJobProperty('a', {
          title: undefined,
          description: '새 설명',
        });

        // 변경된 job 을 그대로 돌려준다 (컨트롤러 응답 바디가 된다)
        expect(edited).toMatchObject({
          title: '기존 제목',
          description: '새 설명',
        });
        expect(await find()).toMatchObject({
          title: '기존 제목',
          description: '새 설명',
        });
      },
    );

    it.each([JobStatus.pending, JobStatus.completed])(
      '%s 상태는 수정할 수 없다',
      async (status) => {
        await seed([job({ status, title: '기존 제목' })]);

        await expect(
          service.editJobProperty('a', { title: '새 제목' }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect((await find()).title).toBe('기존 제목');
      },
    );
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
        const changed = await service.changeStatusCancel('a');

        // 변경된 job 을 그대로 돌려준다 (컨트롤러 응답 바디가 된다)
        expect(changed.status).toBe(JobStatus.canceled);
        expect((await find()).status).toBe(JobStatus.canceled);
        return;
      }

      await expect(service.changeStatusCancel('a')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect((await find()).status).toBe(from);
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
        const changed = await service.changeStatusWait('a');

        expect(changed.status).toBe(JobStatus.waiting);
        expect((await find()).status).toBe(JobStatus.waiting);
        return;
      }

      await expect(service.changeStatusWait('a')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect((await find()).status).toBe(from);
    });
  });

  it('putRecover 는 job 을 통째로 교체한다', async () => {
    await seed([job({ title: '변경된 제목', status: JobStatus.pending })]);

    await service.putRecover(job({ title: '원본 제목' }));

    expect(await find()).toEqual(job({ title: '원본 제목' }));
  });

  it('없는 id 를 조회하면 NotFoundException 을 던진다', async () => {
    await seed([job()]);

    await expect(service.getJob('none')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
