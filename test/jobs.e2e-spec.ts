import { randomUUID } from 'crypto';
import {
  createDataDir,
  createE2EApp,
  E2EApp,
  jobsDBAt,
  recoversDBAt,
  removeDataDir,
  waitFor,
} from './utils/e2e-app.js';
import { Job, JobStatus } from '../src/jobs/types/jobs.types.js';

describe('Jobs (e2e)', () => {
  let dataDir: string;
  let ctx: E2EApp;

  const http = () => ctx.http();

  /** 실제 클라이언트처럼 HTTP 로만 job 을 만든다 */
  const createJob = async (body = { title: '작업', description: '설명' }) => {
    const res = await http().post('/jobs').send(body).expect(201);
    return res.body as Job;
  };

  const getJob = async (id: string) => {
    const res = await http().get(`/jobs/${id}`).expect(200);
    return res.body as Job;
  };

  beforeEach(async () => {
    dataDir = createDataDir();
    ctx = await createE2EApp(dataDir);
  });

  afterEach(async () => {
    await ctx.close();
    removeDataDir(dataDir);
  });

  describe('생성 / 조회', () => {
    it('POST 로 만든 job 은 version 1, waiting 으로 시작하고 그대로 조회된다', async () => {
      const created = await createJob();

      expect(created).toMatchObject({
        title: '작업',
        description: '설명',
        status: JobStatus.waiting,
        version: 1,
      });
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      // 처리/예약 시간은 서버가 정한다
      expect(typeof created.processingTime).toBe('number');

      expect(await getJob(created.id)).toEqual(created);
    });

    it('만든 job 이 목록과 검색에 모두 잡힌다', async () => {
      const report = await createJob({
        title: '리포트 작성',
        description: '설명',
      });
      const deploy = await createJob({ title: '배포', description: '설명' });

      const list = await http().get('/jobs').expect(200);
      expect((list.body as Job[]).map((job) => job.id)).toEqual([
        report.id,
        deploy.id,
      ]);

      const searched = await http()
        .get('/jobs/search')
        .query({ title: '리포트', status: JobStatus.waiting })
        .expect(200);
      expect((searched.body as Job[]).map((job) => job.id)).toEqual([
        report.id,
      ]);
    });

    it('없는 id 는 404, uuid 가 아니면 400 이다', async () => {
      await http().get(`/jobs/${randomUUID()}`).expect(404);
      await http().get('/jobs/not-a-uuid').expect(400);
    });
  });

  describe('버전 기반 수정', () => {
    it('조회한 version 으로 수정하면 값이 바뀌고 version 이 올라간다', async () => {
      const created = await createJob();

      const res = await http()
        .patch(`/jobs/${created.id}`)
        .send({ version: created.version, title: '새 제목' })
        .expect(200);

      expect(res.body).toMatchObject({ title: '새 제목', version: 2 });
      // 응답 바디와 재조회 결과가 같아야 클라이언트가 재조회 없이 다음 요청을 보낼 수 있다
      expect(await getJob(created.id)).toEqual(res.body);
    });

    it('오래된 version 으로 두 번째 수정을 보내면 409 로 막는다 (lost update 방지)', async () => {
      const created = await createJob();

      await http()
        .patch(`/jobs/${created.id}`)
        .send({ version: 1, title: '첫 번째' })
        .expect(200);

      const stale = await http()
        .patch(`/jobs/${created.id}`)
        .send({ version: 1, title: '두 번째' })
        .expect(409);

      expect(stale.body.message[0]).toContain('버전이 일치하지 않습니다');
      // 덮어쓰기가 일어나지 않았다
      expect(await getJob(created.id)).toMatchObject({
        title: '첫 번째',
        version: 2,
      });
    });

    it('같은 version 으로 동시에 수정하면 하나만 성공한다', async () => {
      const created = await createJob();

      const [first, second] = await Promise.all([
        http()
          .patch(`/jobs/${created.id}`)
          .send({ version: 1, title: 'A' })
          .then((res) => res),
        http()
          .patch(`/jobs/${created.id}`)
          .send({ version: 1, title: 'B' })
          .then((res) => res),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 409]);

      const winner = first.status === 200 ? first : second;
      expect(await getJob(created.id)).toMatchObject({
        title: winner.body.title,
        version: 2,
      });
    });

    it('version 없이 보내면 400 이고 아무것도 바뀌지 않는다', async () => {
      const created = await createJob();

      await http()
        .patch(`/jobs/${created.id}`)
        .send({ title: '새 제목' })
        .expect(400);

      expect(await getJob(created.id)).toEqual(created);
    });

    it('version 만 보내면 변경할 필드가 없어 400 이다', async () => {
      const created = await createJob();

      const res = await http()
        .patch(`/jobs/${created.id}`)
        .send({ version: 1 })
        .expect(400);

      expect(res.body.message).toContain('변경할 데이터를 입력해주세요.');
    });
  });

  describe('상태 전이', () => {
    it('취소 → 재대기 왕복마다 version 이 올라간다', async () => {
      const created = await createJob();

      const canceled = await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 1 })
        .expect(200);
      expect(canceled.body).toMatchObject({
        status: JobStatus.canceled,
        version: 2,
      });

      const waiting = await http()
        .patch(`/jobs/${created.id}/wait`)
        .send({ version: 2 })
        .expect(200);
      expect(waiting.body).toMatchObject({
        status: JobStatus.waiting,
        version: 3,
      });
    });

    it('수정으로 version 이 올라간 뒤 예전 version 으로 취소하면 409 다', async () => {
      const created = await createJob();

      await http()
        .patch(`/jobs/${created.id}`)
        .send({ version: 1, title: '새 제목' })
        .expect(200);

      await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 1 })
        .expect(409);

      expect(await getJob(created.id)).toMatchObject({
        status: JobStatus.waiting,
        version: 2,
      });
    });

    it('취소된 job 을 또 취소하면 version 이 맞아도 409 다', async () => {
      const created = await createJob();

      await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 1 })
        .expect(200);

      const res = await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 2 })
        .expect(409);

      expect(res.body.message).toContain(
        '대기/처리중인 작업만 취소 가능합니다',
      );
    });

    it('cancel / wait 에 version 이 없으면 400 이다', async () => {
      const created = await createJob();

      await http().patch(`/jobs/${created.id}/cancel`).send({}).expect(400);
      await http().patch(`/jobs/${created.id}/wait`).send({}).expect(400);

      expect(await getJob(created.id)).toEqual(created);
    });
  });

  describe('스케쥴러 연동', () => {
    it('선점 → 완료까지 version 이 두 번 올라가고 recover 가 정리된다', async () => {
      const created = await createJob();
      await ctx.setProcessingTime(created.id, 0.1);

      await ctx.tick();

      const claimed = await getJob(created.id);
      expect(claimed).toMatchObject({
        status: JobStatus.pending,
        version: 2,
      });
      // 선점 이전(version 1) 원본이 recover 에 남는다
      expect(await ctx.recoverSVC.getRecover(created.id)).toMatchObject({
        version: 1,
        status: JobStatus.waiting,
      });

      await waitFor(
        async () => (await getJob(created.id)).status === JobStatus.completed,
      );

      expect(await getJob(created.id)).toMatchObject({ version: 3 });
      expect(await ctx.recoverSVC.getRecover(created.id)).toBeNull();
    });

    it('선점되면 클라이언트가 들고 있던 version 이 무효가 된다', async () => {
      const created = await createJob();
      await ctx.setProcessingTime(created.id, 0.1);

      await ctx.tick();

      // 선점 전에 조회해 둔 version 1 로는 아무것도 못 한다
      await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 1 })
        .expect(409);

      // version 을 맞춰도 처리중이라 수정은 막힌다
      const res = await http()
        .patch(`/jobs/${created.id}`)
        .send({ version: 2, title: '새 제목' })
        .expect(409);
      expect(res.body.message).toContain('처리중인 작업은 수정할 수 없습니다.');

      await waitFor(
        async () => (await getJob(created.id)).status === JobStatus.completed,
      );
    });

    it('처리 중 취소하면 워커가 완료로 덮지 않는다', async () => {
      const created = await createJob();
      await ctx.setProcessingTime(created.id, 0.3);

      await ctx.tick();
      await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 2 })
        .expect(200);

      // 아무 일도 일어나지 않아야 하는 구간이라 waitFor 가 아니라 처리 시간만큼 기다린다
      await new Promise((resolve) => setTimeout(resolve, 600));

      // 선점(2) → 취소(3) 에서 멈춘다. 워커의 선점 version 은 취소가 무효화했다
      expect(await getJob(created.id)).toMatchObject({
        title: created.title,
        status: JobStatus.canceled,
        version: 3,
      });
      expect(await ctx.recoverSVC.getRecover(created.id)).toBeNull();
    });

    it('처리 중 취소 후 수정한 내용이 워커에 의해 되돌려지지 않는다', async () => {
      const created = await createJob();
      await ctx.setProcessingTime(created.id, 0.3);

      await ctx.tick();
      await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 2 })
        .expect(200);

      // canceled 는 수정이 허용된 상태라 클라이언트는 200 을 받는다
      const edited = await http()
        .patch(`/jobs/${created.id}`)
        .send({ version: 3, title: '사용자가 고친 제목' })
        .expect(200);
      expect(edited.body).toMatchObject({
        title: '사용자가 고친 제목',
        version: 4,
      });

      // 아무 일도 일어나지 않아야 하는 구간이라 waitFor 가 아니라 처리 시간만큼 기다린다
      await new Promise((resolve) => setTimeout(resolve, 600));

      // 200 으로 확정된 수정이 워커 때문에 사라지면 lost update 다
      expect(await getJob(created.id)).toMatchObject({
        title: '사용자가 고친 제목',
        status: JobStatus.canceled,
        version: 4,
      });
      expect(await ctx.recoverSVC.getRecover(created.id)).toBeNull();
    });

    it('waiting 이 없으면 틱이 돌아도 아무 version 도 바뀌지 않는다', async () => {
      const created = await createJob();
      await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 1 })
        .expect(200);

      await ctx.tick();

      expect(await getJob(created.id)).toMatchObject({
        status: JobStatus.canceled,
        version: 2,
      });
    });

    it('처리 중 취소 후 재대기한 job 은 워커가 끝난 뒤에 한 번만 다시 처리된다', async () => {
      const created = await createJob();
      await ctx.setProcessingTime(created.id, 0.3);

      await ctx.tick();
      // 취소 후 마음을 바꿔 재대기로 돌리는 것은 허용된 흐름이다 (선점 2 → 취소 3 → 재대기 4)
      await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 2 })
        .expect(200);
      await http()
        .patch(`/jobs/${created.id}/wait`)
        .send({ version: 3 })
        .expect(200);

      // waiting 이지만 워커가 아직 도는 중이라 틱이 집어가면 안 된다.
      // 여기서 선점되면 같은 job 을 워커 둘이 동시에 처리한다
      await ctx.tick();
      expect(await getJob(created.id)).toMatchObject({
        status: JobStatus.waiting,
        version: 4,
      });

      // 워커가 끝나면 다시 선점된다 (끝나도 선점되지 않으면 job 이 영구히 멈춘다)
      await waitFor(async () => {
        await ctx.tick();
        return (await getJob(created.id)).status === JobStatus.pending;
      });
      expect(await getJob(created.id)).toMatchObject({ version: 5 });

      await waitFor(
        async () => (await getJob(created.id)).status === JobStatus.completed,
      );
      expect(await getJob(created.id)).toMatchObject({ version: 6 });
      expect(await ctx.recoverSVC.getRecover(created.id)).toBeNull();
    });
  });

  describe('재기동 리커버리', () => {
    const ID = randomUUID();
    const origin: Job = {
      id: ID,
      version: 1,
      title: '원본 제목',
      status: JobStatus.waiting,
      reservationTime: 0,
      processingTime: 5,
    };

    /**
     * 프로세스가 죽은 직후의 디스크 상태를 심고 앱을 다시 띄운다.
     * recover 행은 항상 선점 이전 스냅샷(version 1)이므로,
     * job 쪽 version 을 몇으로 심느냐가 "죽기 전에 어디까지 진행됐는지" 를 정한다
     */
    const restartWith = async (current: Partial<Job>) => {
      await ctx.close();
      removeDataDir(dataDir);

      dataDir = createDataDir();
      await jobsDBAt(dataDir).push('/list', [{ ...origin, ...current }]);
      await recoversDBAt(dataDir).push('/list', { [ID]: origin });
      ctx = await createE2EApp(dataDir);
    };

    it('선점 직후 죽은 job 은 재기동 시 waiting 으로 되돌아간다', async () => {
      // 선점(2) 까지만 진행된 상태 = 스냅샷(1) + 1
      await restartWith({ version: 2, status: JobStatus.pending });

      expect(await getJob(ID)).toMatchObject({
        title: '원본 제목',
        status: JobStatus.waiting,
        // status 만 되돌리고 version 은 되돌리지 않는다
        version: 3,
      });
      expect(await ctx.recoverSVC.getRecover(ID)).toBeNull();

      // 죽기 전 version(2) 을 들고 있던 클라이언트는 거절된다
      await http()
        .patch(`/jobs/${ID}`)
        .send({ version: 2, title: '새 제목' })
        .expect(409);
    });

    it.each([
      ['취소', JobStatus.canceled],
      ['완료', JobStatus.completed],
    ])(
      '죽기 전에 %s 까지 진행된 job 은 되돌리지 않고 찌꺼기 recover 만 지운다',
      async (_, status) => {
        // 선점(2) 다음 상태 변경(3) 까지 갔으므로 스냅샷 + 1 이 아니다
        await restartWith({ version: 3, status });

        expect(await getJob(ID)).toMatchObject({
          title: '원본 제목',
          status,
          version: 3,
        });
        expect(await ctx.recoverSVC.getRecover(ID)).toBeNull();
      },
    );

    it('선점 이후 수정된 job 은 재기동해도 수정 내용이 유지된다', async () => {
      // 선점(2) → 취소(3) → 사용자 수정(4) 까지 간 상태에서 죽은 디스크
      await restartWith({
        version: 4,
        title: '사용자가 고친 제목',
        status: JobStatus.canceled,
      });

      // 스냅샷을 덮어쓰면 200 으로 확정됐던 수정이 재기동 때 사라진다
      expect(await getJob(ID)).toMatchObject({
        title: '사용자가 고친 제목',
        status: JobStatus.canceled,
        version: 4,
      });
      expect(await ctx.recoverSVC.getRecover(ID)).toBeNull();
    });
  });

  describe('에러 응답 형식', () => {
    it('400 / 404 / 409 모두 { statusCode, message[] } 다', async () => {
      const created = await createJob();
      await http()
        .patch(`/jobs/${created.id}/cancel`)
        .send({ version: 1 })
        .expect(200);

      // 발생 지점(DTO / 파이프 / 서비스)이 달라도 한 가지 모양이어야 한다
      const cases = [
        [400, () => http().patch(`/jobs/${created.id}`).send({})],
        [400, () => http().get('/jobs/not-a-uuid')],
        [404, () => http().get(`/jobs/${randomUUID()}`)],
        [
          409,
          () => http().patch(`/jobs/${created.id}/cancel`).send({ version: 2 }),
        ],
        [
          409,
          () => http().patch(`/jobs/${created.id}/wait`).send({ version: 99 }),
        ],
      ] as const;

      for (const [status, call] of cases) {
        const res = await call().expect(status);

        expect(Object.keys(res.body).sort()).toEqual(['message', 'statusCode']);
        expect(res.body.statusCode).toBe(status);
        expect(Array.isArray(res.body.message)).toBe(true);
        expect(
          res.body.message.every((m: unknown) => typeof m === 'string'),
        ).toBe(true);
      }
    });
  });
});
