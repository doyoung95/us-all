import { readFileSync } from 'fs';
import { join } from 'path';
import { Job, JobStatus } from '../src/jobs/types/jobs.types.js';
import {
  createDataDir,
  createE2EApp,
  E2EApp,
  removeDataDir,
  waitFor,
} from './utils/e2e-app.js';
import { apiClient, printReport, printTable, runLoad } from './utils/load.js';

/**
 * 부하 시나리오.
 *
 * 처리량/지연은 머신·디스크에 따라 달라지므로 테스트가 단정하지 않고 리포트로만 찍는다.
 * 테스트가 단정하는 것은 부하를 줘도 지켜져야 하는 불변식이다.
 * - 버전이 맞는 요청만 성공하고, 성공 횟수만큼만 version 이 올라간다 (잃어버린 갱신 없음)
 * - 같은 version 으로 동시에 들어온 요청 중 성공은 정확히 하나다
 * - 응답이 끝난 시점에 디스크 파일도 같은 상태다
 *
 * `pnpm test:load` 로 따로 돌린다. 일반 테스트 스위트에는 들어가지 않는다.
 */
describe('Jobs 부하', () => {
  let dataDir: string;
  let ctx: E2EApp;
  let api: ReturnType<typeof apiClient>;

  // 시나리오마다 앱을 새로 띄운다. 앞 시나리오가 남긴 job 이 있으면
  // 스케쥴러가 그걸 선점해 버려서 수치도 불변식도 의미가 없어진다
  beforeEach(async () => {
    dataDir = createDataDir();
    ctx = await createE2EApp(dataDir);
    api = apiClient(await ctx.listen());
  });

  afterEach(async () => {
    await ctx.close();
    removeDataDir(dataDir);
  });

  /** 서비스의 인메모리 캐시가 아니라 디스크에 실제로 뭐가 남았는지 본다 */
  const jobsOnDisk = (): Job[] =>
    (
      JSON.parse(readFileSync(join(dataDir, 'jobs.json'), 'utf8')) as {
        list: Job[];
      }
    ).list;

  const createJobs = async (
    count: number,
    concurrency: number,
    { quiet = false } = {},
  ) => {
    // 동시 요청이라 완료 순서가 뒤섞인다. ids[i] 가 '작업-i' 이도록 인덱스로 담는다
    const ids: string[] = Array.from({ length: count }) as string[];

    const created = await runLoad({
      name: `생성 (POST /jobs)`,
      total: count,
      concurrency,
      task: async (i) => {
        const res = await api.post('/jobs', { title: `작업-${i}` });
        if (res.status === 201) ids[i] = (res.body as Job).id;
        return res.status;
      },
    });
    if (!quiet) printReport(created);

    expect(created.byStatus[201]).toBe(count);
    return { ids, created };
  };

  it('읽기 경로 처리량 (GET /jobs)', async () => {
    await createJobs(100, 20);

    for (const concurrency of [1, 10, 50, 100]) {
      const read = await runLoad({
        name: `목록 조회 (GET /jobs, job 100개)`,
        total: 1000,
        concurrency,
        task: async () => (await api.get('/jobs')).status,
      });
      printReport(read);

      expect(read.byStatus[200]).toBe(1000);
    }
  });

  it('서로 다른 job 을 동시에 수정하면 충돌 없이 전부 성공한다', async () => {
    const { ids } = await createJobs(200, 25);
    const before = jobsOnDisk().length;

    const write = await runLoad({
      name: `경합 없는 수정 (job ${ids.length}개 / 각 1회)`,
      total: ids.length,
      concurrency: 50,
      task: async (i) =>
        (
          await api.patch(`/jobs/${ids[i]}`, {
            version: 1,
            title: `수정-${i}`,
          })
        ).status,
    });
    printReport(write);

    // 경합이 없으므로 버전 충돌은 0 이어야 한다
    expect(write.byStatus[200]).toBe(ids.length);
    expect(write.byStatus[409]).toBeUndefined();

    // 동시에 같은 JSON 파일을 쓰는데도 서로를 덮지 않았는지 디스크로 확인한다
    const onDisk = jobsOnDisk();
    expect(onDisk).toHaveLength(before);

    const byId = new Map(onDisk.map((job) => [job.id, job]));
    ids.forEach((id, i) => {
      expect(byId.get(id)).toMatchObject({ title: `수정-${i}`, version: 2 });
    });
  });

  it('같은 version 으로 동시에 몰리면 성공은 정확히 1건, 나머지는 전부 409 다', async () => {
    const {
      ids: [id],
    } = await createJobs(1, 1, { quiet: true });

    for (const concurrency of [10, 50, 200]) {
      const current = (await api.get(`/jobs/${id}`)).body as Job;

      const burst = await runLoad({
        name: `단일 job 경합 (동시 ${concurrency}, 모두 version ${current.version})`,
        total: concurrency,
        concurrency,
        task: async (i) =>
          (
            await api.patch(`/jobs/${id}`, {
              version: current.version,
              title: `경합-${i}`,
            })
          ).status,
      });
      printReport(burst);

      // 낙관적 잠금의 핵심: 동시에 몰려도 한 건만 통과한다
      expect(burst.byStatus[200]).toBe(1);
      expect(burst.byStatus[409]).toBe(concurrency - 1);

      const after = (await api.get(`/jobs/${id}`)).body as Job;
      expect(after.version).toBe(current.version + 1);
    }
  });

  it('재시도까지 포함하면 동시성이 오를수록 충돌이 몇 배로 쌓이는지', async () => {
    const SUCCESSES = 32;
    const rows: Record<string, unknown>[] = [];

    for (const concurrency of [1, 2, 4, 8, 16, 32]) {
      const {
        ids: [id],
      } = await createJobs(1, 1, { quiet: true });

      const perWorker = SUCCESSES / concurrency;
      let attempts = 0;
      let conflicts = 0;

      // 실제 클라이언트 흐름: 조회 → 수정, 409 면 다시 조회해서 재시도
      const worker = async (worker: number) => {
        for (let n = 0; n < perWorker; n++) {
          for (;;) {
            const current = (await api.get(`/jobs/${id}`)).body as Job;
            attempts++;
            const res = await api.patch(`/jobs/${id}`, {
              version: current.version,
              title: `w${worker}-${n}`,
            });
            if (res.status === 200) break;

            expect(res.status).toBe(409);
            conflicts++;
          }
        }
      };

      const startedAt = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, (_, w) => worker(w)),
      );
      const wallMs = performance.now() - startedAt;

      const final = (await api.get(`/jobs/${id}`)).body as Job;
      // 성공한 횟수만큼만 version 이 올라갔다 = 잃어버린 갱신이 없다
      expect(final.version).toBe(1 + SUCCESSES);

      rows.push({
        동시성: concurrency,
        성공: SUCCESSES,
        시도: attempts,
        충돌: conflicts,
        '충돌률(%)': ((conflicts / attempts) * 100).toFixed(1),
        '성공당 시도': (attempts / SUCCESSES).toFixed(2),
        '소요(ms)': wallMs.toFixed(0),
      });
    }

    printTable(`read-modify-write 재시도 (성공 ${SUCCESSES}회 고정)`, rows);
  });

  it('같은 job 에 몰릴수록 버전 불일치 실패가 얼마나 쌓이는지', async () => {
    const CONCURRENCY = 32;
    const REQUESTS = 128;
    const rows: Record<string, unknown>[] = [];

    for (const poolSize of [1, 2, 4, 8, 16, 32]) {
      const { ids } = await createJobs(poolSize, Math.min(poolSize, 10), {
        quiet: true,
      });

      // 재시도 없는 단발 요청. 클라이언트가 체감하는 "그냥 실패한" 비율이다
      const blind = await runLoad({
        name: `조회 후 단발 수정 (동시 ${CONCURRENCY}, job 풀 ${poolSize}개)`,
        total: REQUESTS,
        concurrency: CONCURRENCY,
        task: async (i) => {
          const id = ids[i % poolSize];
          const current = (await api.get(`/jobs/${id}`)).body as Job;
          return (
            await api.patch(`/jobs/${id}`, {
              version: current.version,
              title: `blind-${i}`,
            })
          ).status;
        },
      });

      const ok = blind.byStatus[200] ?? 0;
      const conflict = blind.byStatus[409] ?? 0;
      expect(ok + conflict).toBe(REQUESTS);

      // 성공한 만큼만 version 이 올랐다 = 실패한 요청은 아무것도 덮어쓰지 않았다
      const finals = await Promise.all(
        ids.map(async (id) => (await api.get(`/jobs/${id}`)).body as Job),
      );
      const bumped = finals.reduce((sum, job) => sum + job.version - 1, 0);
      expect(bumped).toBe(ok);

      rows.push({
        'job 풀': poolSize,
        요청: REQUESTS,
        성공: ok,
        '충돌(409)': conflict,
        '실패율(%)': ((conflict / REQUESTS) * 100).toFixed(1),
        'p95(ms)': blind.p95.toFixed(1),
        'req/s': blind.rps.toFixed(0),
      });
    }

    printTable(`버전 불일치 누적 (동시 ${CONCURRENCY}, 재시도 없음)`, rows);
  });

  it('스케쥴러가 도는 중에 취소가 몰려도 상태와 원본이 깨지지 않는다', async () => {
    const COUNT = 20;
    const { ids } = await createJobs(COUNT, 10);
    for (const id of ids) {
      await ctx.setProcessingTime(id, 0.05);
    }

    let canceled = 0;
    let rejected = 0;

    // 틱(선점)과 취소 요청을 동시에 던진다
    const ticking = (async () => {
      for (let i = 0; i < COUNT * 2; i++) {
        await ctx.tick();
      }
    })();

    const canceling = runLoad({
      name: `스케쥴러 경합 (job ${COUNT}개 취소 시도)`,
      total: COUNT,
      concurrency: 10,
      task: async (i) => {
        const current = (await api.get(`/jobs/${ids[i]}`)).body as Job;
        const res = await api.patch(`/jobs/${ids[i]}/cancel`, {
          version: current.version,
        });
        if (res.status === 200) canceled++;
        else rejected++;
        return res.status;
      },
    });

    const [, cancelReport] = await Promise.all([ticking, canceling]);
    printReport(cancelReport);

    // 모든 job 이 종착 상태(completed/canceled)로 수렴할 때까지 기다린다
    const isSettled = (job: Job) =>
      job.status === JobStatus.completed || job.status === JobStatus.canceled;

    await waitFor(async () => {
      const jobs = (await api.get('/jobs')).body as Job[];
      return jobs.every(isSettled);
    }, 10_000);

    const jobs = (await api.get('/jobs')).body as Job[];
    for (const [i, id] of ids.entries()) {
      const job = jobs.find((item) => item.id === id)!;

      // 취소된 job 은 처리 완료가 덮어쓰지 않고 원본 제목이 살아 있어야 한다
      if (job.status === JobStatus.canceled) {
        expect(job.title).toBe(`작업-${i}`);
      }
      // recover 찌꺼기가 남으면 다음 부팅 때 되살아난다
      expect(await ctx.recoverSVC.getRecover(id)).toBeNull();
    }

    printTable('스케쥴러 경합 결과', [
      {
        '취소 성공': canceled,
        '취소 거절': rejected,
        completed: jobs.filter((j) => j.status === JobStatus.completed).length,
        canceled: jobs.filter((j) => j.status === JobStatus.canceled).length,
      },
    ]);
  });
});
