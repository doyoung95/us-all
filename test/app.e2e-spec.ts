import {
  createDataDir,
  createE2EApp,
  E2EApp,
  removeDataDir,
} from './utils/e2e-app.js';

describe('App (e2e)', () => {
  let dataDir: string;
  let ctx: E2EApp;

  beforeAll(async () => {
    dataDir = createDataDir();
    ctx = await createE2EApp(dataDir);
  });

  afterAll(async () => {
    await ctx.close();
    removeDataDir(dataDir);
  });

  it('AppModule 이 뜨고 jobs 라우트가 붙는다', async () => {
    await ctx.http().get('/jobs').expect(200);
  });

  it('등록되지 않은 경로도 공통 에러 포맷으로 404 를 낸다', async () => {
    const res = await ctx.http().get('/nope').expect(404);

    expect(res.body).toEqual({
      statusCode: 404,
      message: ['Cannot GET /nope'],
    });
  });
});
