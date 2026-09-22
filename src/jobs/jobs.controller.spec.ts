import {
  ConflictException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AllExceptionsFilter } from '../common/http-exception.filter.js';
import { AppLogger } from '../logger/app-logger.service.js';
import request from 'supertest';
import { vi } from 'vitest';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { Job, JobStatus } from './types/jobs.types.js';

// 실제 logs.txt 를 건드리지 않도록 임시 파일로 돌린다
const TMP_DIR = mkdtempSync(join(tmpdir(), 'jobs-controller-spec-'));
process.env.LOG_FILE = join(TMP_DIR, 'logs.txt');
const logger = new AppLogger();

// ParseUUIDPipe 기본값(v3/v4/v5)을 통과하는 id
const ID = '11111111-1111-4111-8111-111111111111';

const job = (override: Partial<Job> = {}): Job => ({
  id: ID,
  version: 1,
  title: '작업',
  description: '설명',
  status: JobStatus.waiting,
  reservationTime: 3,
  processingTime: 5,
  ...override,
});

describe('JobsController', () => {
  let app: INestApplication;
  let jobsSVC: Record<keyof JobsService & string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    jobsSVC = {
      create: vi.fn(),
      getJobs: vi.fn(),
      searchJobs: vi.fn(),
      getJob: vi.fn(),
      editJobProperty: vi.fn(),
      changeStatusCancel: vi.fn(),
      changeStatusWait: vi.fn(),
    } as never;

    const moduleRef = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [{ provide: JobsService, useValue: jobsSVC }],
    }).compile();

    app = moduleRef.createNestApplication();
    // DTO/파이프/에러 포맷까지 함께 검증하려면 main.ts 와 같은 설정이어야 한다
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(logger));
    await app.init();
  });

  afterEach(() => app.close());

  afterAll(async () => {
    await logger.close();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());

  describe('POST /jobs', () => {
    it('201 과 생성된 job 전체를 반환한다', async () => {
      jobsSVC.create.mockResolvedValue(job());

      const res = await http()
        .post('/jobs')
        .send({ title: '작업', description: '설명' })
        .expect(201);

      expect(res.body).toEqual(job());
      expect(jobsSVC.create).toHaveBeenCalledWith({
        title: '작업',
        description: '설명',
      });
    });

    it('응답에 version 이 포함된다', async () => {
      jobsSVC.create.mockResolvedValue(job());

      const res = await http()
        .post('/jobs')
        .send({ title: '작업' })
        .expect(201);

      expect(res.body.version).toBe(1);
    });

    it.each([
      ['title 이 없으면', {}],
      ['title 이 빈 문자열이면', { title: '' }],
      ['title 이 문자열이 아니면', { title: 123 }],
    ])('%s 400 이고 서비스를 호출하지 않는다', async (_, body) => {
      await http().post('/jobs').send(body).expect(400);

      expect(jobsSVC.create).not.toHaveBeenCalled();
    });

    it('status/version 같은 서버 결정 필드는 whitelist 로 걸러진다', async () => {
      jobsSVC.create.mockResolvedValue(job());

      await http()
        .post('/jobs')
        .send({ title: '작업', status: JobStatus.completed, version: 99 })
        .expect(201);

      expect(jobsSVC.create).toHaveBeenCalledWith({ title: '작업' });
    });
  });

  describe('GET /jobs', () => {
    it('목록을 그대로 반환한다', async () => {
      jobsSVC.getJobs.mockResolvedValue([job(), job({ id: 'b' })]);

      const res = await http().get('/jobs').expect(200);

      expect(res.body).toHaveLength(2);
    });
  });

  describe('GET /jobs/search', () => {
    it('/:id 라우트에 먹히지 않고 검색 쿼리를 그대로 넘긴다', async () => {
      jobsSVC.searchJobs.mockResolvedValue([job()]);

      await http()
        .get('/jobs/search')
        .query({ title: '리포트', status: JobStatus.waiting })
        .expect(200);

      expect(jobsSVC.searchJobs).toHaveBeenCalledWith({
        title: '리포트',
        status: JobStatus.waiting,
      });
      expect(jobsSVC.getJob).not.toHaveBeenCalled();
    });

    it('status 가 enum 값이 아니면 400 이다', async () => {
      await http().get('/jobs/search').query({ status: 'unknown' }).expect(400);

      expect(jobsSVC.searchJobs).not.toHaveBeenCalled();
    });
  });

  describe('GET /jobs/:id', () => {
    it('내부 인덱스(idx)는 감추고 job 만 반환한다', async () => {
      jobsSVC.getJob.mockResolvedValue({ idx: 3, job: job() });

      const res = await http().get(`/jobs/${ID}`).expect(200);

      expect(res.body).toEqual(job());
      expect(res.body).not.toHaveProperty('idx');
      // 다음 수정 요청에 넣을 version 은 조회 응답으로 알 수 있어야 한다
      expect(res.body.version).toBe(1);
    });

    it('uuid 형식이 아니면 400 이다', async () => {
      await http().get('/jobs/not-a-uuid').expect(400);

      expect(jobsSVC.getJob).not.toHaveBeenCalled();
    });

    it('없는 job 이면 404 이다', async () => {
      jobsSVC.getJob.mockRejectedValue(new NotFoundException());

      await http().get(`/jobs/${ID}`).expect(404);
    });
  });

  describe('PATCH /jobs/:id', () => {
    it('version 과 수정 필드를 함께 넘기고 수정된 job 전체를 반환한다', async () => {
      const edited = job({ title: '새 제목', version: 2 });
      jobsSVC.editJobProperty.mockResolvedValue(edited);

      const res = await http()
        .patch(`/jobs/${ID}`)
        .send({ version: 1, title: '새 제목' })
        .expect(200);

      expect(res.body).toEqual(edited);
      expect(jobsSVC.editJobProperty).toHaveBeenCalledWith(ID, {
        version: 1,
        title: '새 제목',
      });
    });

    it('빈 바디는 400 이고 이유를 메시지로 알려준다', async () => {
      const res = await http().patch(`/jobs/${ID}`).send({}).expect(400);

      expect(res.body.message).toContain('변경할 데이터를 입력해주세요.');
      expect(jobsSVC.editJobProperty).not.toHaveBeenCalled();
    });

    it('version 만 있고 수정할 필드가 없으면 400 이다', async () => {
      const res = await http()
        .patch(`/jobs/${ID}`)
        .send({ version: 1 })
        .expect(400);

      expect(res.body.message).toContain('변경할 데이터를 입력해주세요.');
      expect(jobsSVC.editJobProperty).not.toHaveBeenCalled();
    });

    it.each([
      ['version 이 없으면', { title: '새 제목' }],
      ['version 이 숫자가 아니면', { version: '1', title: '새 제목' }],
      ['version 이 null 이면', { version: null, title: '새 제목' }],
    ])('%s 400 이고 서비스를 호출하지 않는다', async (_, body) => {
      await http().patch(`/jobs/${ID}`).send(body).expect(400);

      expect(jobsSVC.editJobProperty).not.toHaveBeenCalled();
    });

    it('status 는 PATCH 로 바꿀 수 없어 400 이다', async () => {
      await http()
        .patch(`/jobs/${ID}`)
        .send({ version: 1, status: JobStatus.completed })
        .expect(400);

      expect(jobsSVC.editJobProperty).not.toHaveBeenCalled();
    });

    it('수정할 수 없는 상태면 409 와 사유를 반환한다', async () => {
      jobsSVC.editJobProperty.mockRejectedValue(
        new ConflictException('처리중인 작업은 수정할 수 없습니다.'),
      );

      const res = await http()
        .patch(`/jobs/${ID}`)
        .send({ version: 1, title: '새 제목' })
        .expect(409);

      expect(res.body.message).toContain('처리중인 작업은 수정할 수 없습니다.');
    });

    it('version 이 어긋나면 409 와 현재/요청 version 을 알려준다', async () => {
      jobsSVC.editJobProperty.mockRejectedValue(
        new ConflictException('버전이 일치하지 않습니다. current=3, request=1'),
      );

      const res = await http()
        .patch(`/jobs/${ID}`)
        .send({ version: 1, title: '새 제목' })
        .expect(409);

      expect(res.body.message).toContain(
        '버전이 일치하지 않습니다. current=3, request=1',
      );
    });
  });

  describe('PATCH /jobs/:id/cancel', () => {
    it('바디의 version 을 서비스로 넘기고 취소된 job 을 반환한다', async () => {
      jobsSVC.changeStatusCancel.mockResolvedValue(
        job({ status: JobStatus.canceled, version: 2 }),
      );

      const res = await http()
        .patch(`/jobs/${ID}/cancel`)
        .send({ version: 1 })
        .expect(200);

      expect(res.body.status).toBe(JobStatus.canceled);
      expect(res.body.version).toBe(2);
      expect(jobsSVC.changeStatusCancel).toHaveBeenCalledWith(ID, 1);
    });

    it.each([
      ['바디가 비어 있으면', {}],
      ['version 이 숫자가 아니면', { version: '1' }],
    ])('%s 400 이고 서비스를 호출하지 않는다', async (_, body) => {
      await http().patch(`/jobs/${ID}/cancel`).send(body).expect(400);

      expect(jobsSVC.changeStatusCancel).not.toHaveBeenCalled();
    });

    it('취소할 수 없는 상태면 409 이다', async () => {
      jobsSVC.changeStatusCancel.mockRejectedValue(
        new ConflictException('대기/처리중인 작업만 취소 가능합니다'),
      );

      await http().patch(`/jobs/${ID}/cancel`).send({ version: 1 }).expect(409);
    });

    it('version 이 어긋나면 409 이다', async () => {
      jobsSVC.changeStatusCancel.mockRejectedValue(
        new ConflictException('버전이 일치하지 않습니다. current=2, request=1'),
      );

      await http().patch(`/jobs/${ID}/cancel`).send({ version: 1 }).expect(409);
    });
  });

  describe('PATCH /jobs/:id/wait', () => {
    it('바디의 version 을 서비스로 넘기고 대기로 돌아온 job 을 반환한다', async () => {
      jobsSVC.changeStatusWait.mockResolvedValue(
        job({ status: JobStatus.waiting, version: 3 }),
      );

      const res = await http()
        .patch(`/jobs/${ID}/wait`)
        .send({ version: 2 })
        .expect(200);

      expect(res.body.status).toBe(JobStatus.waiting);
      expect(res.body.version).toBe(3);
      expect(jobsSVC.changeStatusWait).toHaveBeenCalledWith(ID, 2);
    });

    it.each([
      ['바디가 비어 있으면', {}],
      ['version 이 숫자가 아니면', { version: '2' }],
    ])('%s 400 이고 서비스를 호출하지 않는다', async (_, body) => {
      await http().patch(`/jobs/${ID}/wait`).send(body).expect(400);

      expect(jobsSVC.changeStatusWait).not.toHaveBeenCalled();
    });

    it('복구할 수 없는 상태면 409 이다', async () => {
      jobsSVC.changeStatusWait.mockRejectedValue(
        new ConflictException('취소된 작업만 복구 가능합니다.'),
      );

      await http().patch(`/jobs/${ID}/wait`).send({ version: 1 }).expect(409);
    });

    it('version 이 어긋나면 409 이다', async () => {
      jobsSVC.changeStatusWait.mockRejectedValue(
        new ConflictException('버전이 일치하지 않습니다. current=5, request=1'),
      );

      await http().patch(`/jobs/${ID}/wait`).send({ version: 1 }).expect(409);
    });
  });

  describe('에러 응답 형식', () => {
    // 발생 지점(파이프 / DTO / 서비스)이 달라도 한 가지 모양이어야 한다
    const cases = [
      {
        name: '400 (DTO 검증)',
        status: 400,
        call: () => http().patch(`/jobs/${ID}`).send({}),
      },
      {
        name: '400 (version 누락)',
        status: 400,
        call: () => http().patch(`/jobs/${ID}/cancel`).send({}),
      },
      {
        name: '400 (uuid 형식)',
        status: 400,
        call: () => http().get('/jobs/not-a-uuid'),
      },
      {
        name: '404 (없는 job)',
        status: 404,
        call: () => {
          jobsSVC.getJob.mockRejectedValue(new NotFoundException());
          return http().get(`/jobs/${ID}`);
        },
      },
      {
        name: '409 (전이 불가)',
        status: 409,
        call: () => {
          jobsSVC.changeStatusCancel.mockRejectedValue(
            new ConflictException('대기/처리중인 작업만 취소 가능합니다'),
          );
          return http().patch(`/jobs/${ID}/cancel`).send({ version: 1 });
        },
      },
      {
        name: '409 (version 불일치)',
        status: 409,
        call: () => {
          jobsSVC.changeStatusCancel.mockRejectedValue(
            new ConflictException(
              '버전이 일치하지 않습니다. current=2, request=1',
            ),
          );
          return http().patch(`/jobs/${ID}/cancel`).send({ version: 1 });
        },
      },
    ];

    it.each(cases)(
      '$name 도 { statusCode, message[] } 다',
      async ({ status, call }) => {
        const res = await call().expect(status);

        expect(Object.keys(res.body).sort()).toEqual(['message', 'statusCode']);
        expect(res.body.statusCode).toBe(status);
        expect(Array.isArray(res.body.message)).toBe(true);
        expect(
          res.body.message.every((m: unknown) => typeof m === 'string'),
        ).toBe(true);
      },
    );

    it('예상치 못한 에러는 500 이고 내부 정보를 노출하지 않는다', async () => {
      jobsSVC.getJobs.mockRejectedValue(new Error('jobs.json 을 읽을 수 없음'));

      const res = await http().get('/jobs').expect(500);

      expect(res.body.message).toEqual(['서버 오류가 발생했습니다.']);
      expect(JSON.stringify(res.body)).not.toContain('jobs.json');
    });
  });
});
