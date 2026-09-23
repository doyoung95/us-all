import { INestApplication, ValidationPipe } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'fs';
import { AddressInfo } from 'net';
import { ConfigWithAdapter, JsonAdapter, JsonDB } from 'node-json-db';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { AllExceptionsFilter } from '../../src/common/http-exception.filter.js';
import { JobsScheduler } from '../../src/jobs/jobs.scheduler.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { RecoverJobService } from '../../src/jobs/recover-job/recover-job.service.js';
import { AppLogger } from '../../src/logger/app-logger.service.js';
import { AtomicFileAdapter } from '../../src/util/atomic-file.adapter.js';

export const createDataDir = () => mkdtempSync(join(tmpdir(), 'jobs-e2e-'));

export const removeDataDir = (dir: string) =>
  rmSync(dir, { recursive: true, force: true });

/**
 * 서비스와 같은 방식으로 DB 를 만든다.
 * 다르게 만들면 부하 수치가 실제 쓰기 경로(임시 파일 + fsync + rename)를 반영하지 못하고,
 * 배선 실수도 테스트가 잡지 못한다
 */
const openDB = (dir: string, name: string) =>
  new JsonDB(
    new ConfigWithAdapter(
      new JsonAdapter(new AtomicFileAdapter(join(dir, `${name}.json`)), false),
      true,
      '/',
    ),
  );

// 앱이 뜨기 전에 "죽은 시점의 디스크 상태" 를 직접 만들어 둘 때 쓴다
export const jobsDBAt = (dir: string) => openDB(dir, 'jobs');
export const recoversDBAt = (dir: string) => openDB(dir, 'recovers');

export type E2EApp = Awaited<ReturnType<typeof createE2EApp>>;

/**
 * AppModule 전체를 띄운다. 실제와 다른 부분은 두 가지뿐이다.
 * - data/*.json 대신 임시 디렉터리를 쓴다
 * - 1초 @Cron 을 떼고 tick() 으로 직접 돌린다 (자동 틱이 있으면 검증이 비결정적이다)
 */
export const createE2EApp = async (dataDir: string) => {
  // AppLogger 는 생성자에서 스트림을 열기 때문에 DI 컨테이너보다 먼저 지정해야 한다
  process.env.LOG_FILE = join(dataDir, 'logs.txt');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const jobsSVC = moduleRef.get(JobsService);
  const recoverSVC = moduleRef.get(RecoverJobService);
  const scheduler = moduleRef.get(JobsScheduler);
  const logger = moduleRef.get(AppLogger);

  // onModuleInit / onApplicationBootstrap 은 app.init() 에서 돌기 때문에
  // 지금 갈아끼워야 초기화와 부팅 리커버리까지 임시 파일 위에서 돈다
  const jobsDB = jobsDBAt(dataDir);
  (jobsSVC as unknown as { db: JsonDB }).db = jobsDB;
  (recoverSVC as unknown as { db: JsonDB }).db = recoversDBAt(dataDir);

  const app: INestApplication = moduleRef.createNestApplication();
  // main.ts 와 같은 전역 설정이어야 e2e 가 실제 응답을 검증하는 게 된다
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  await app.init();

  const registry = app.get(SchedulerRegistry);
  for (const name of registry.getCronJobs().keys()) {
    registry.deleteCronJob(name);
  }

  return {
    app,
    jobsSVC,
    recoverSVC,
    scheduler,
    http: () => request(app.getHttpServer()),

    /**
     * 실제 포트를 열고 base url 을 돌려준다.
     * supertest 는 요청마다 리스너를 새로 띄워서 부하 테스트에는 쓸 수 없다
     */
    listen: async () => {
      await app.listen(0);
      const { port } = app.getHttpServer().address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    },

    /** 스케쥴러 틱 1회. 선점까지만 기다리고 처리 완료는 fire-and-forget 이다 */
    tick: () => scheduler.consume(),

    /** 생성 시 처리 시간은 1~20초 랜덤이라 e2e 가 기다릴 수 없다. 이 값만 줄인다 */
    setProcessingTime: async (id: string, sec: number) => {
      const { idx } = await jobsSVC.getJob(id);
      await jobsDB.push(`/list[${idx}]`, { processingTime: sec }, false);
    },

    close: async () => {
      await app.close();
      await logger.close();
    },
  };
};

export const waitFor = async (
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor: 시간 내에 조건이 만족되지 않았습니다.');
};
