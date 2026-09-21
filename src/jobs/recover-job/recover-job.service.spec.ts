import { mkdtempSync, rmSync } from 'fs';
import { Config, JsonDB } from 'node-json-db';
import { tmpdir } from 'os';
import { join } from 'path';
import { Job, JobStatus } from '../types/jobs.types.js';
import { RecoverJobService } from './recover-job.service.js';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'recover-job-spec-'));
let seq = 0;

const job = (override: Partial<Job> = {}): Job => ({
  id: 'a',
  title: '작업',
  status: JobStatus.waiting,
  reservationTime: 0,
  processingTime: 1,
  ...override,
});

describe('RecoverJobService', () => {
  let service: RecoverJobService;

  beforeEach(async () => {
    service = new RecoverJobService();
    // 실제 data/recovers.json 대신 테스트마다 새 임시 파일을 쓴다
    (service as unknown as { db: JsonDB }).db = new JsonDB(
      new Config(join(TMP_DIR, `db-${seq++}`), true, false, '/'),
    );
    await service.onModuleInit();
  });

  afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('원본 job 을 저장하고 id 로 조회한 뒤 삭제할 수 있다', async () => {
    const origin = job({ title: '원본 제목' });

    await service.genRecover(origin);
    expect(await service.getRecover('a')).toEqual(origin);

    await service.removeRecover('a');
    expect(await service.getRecover('a')).toBeNull();
  });

  it('같은 id 로 다시 저장하면 최신 원본으로 덮어쓴다', async () => {
    await service.genRecover(job({ title: '첫 번째' }));
    await service.genRecover(job({ title: '두 번째', processingTime: 7 }));

    expect(await service.getRecover('a')).toEqual(
      job({ title: '두 번째', processingTime: 7 }),
    );
  });

  it('getRecovers 는 저장된 원본 전체를 배열로 반환한다', async () => {
    expect(await service.getRecovers()).toEqual([]);

    await service.genRecover(job({ id: 'a' }));
    await service.genRecover(job({ id: 'b' }));

    expect(await service.getRecovers()).toEqual([
      job({ id: 'a' }),
      job({ id: 'b' }),
    ]);
  });

  it('없는 id 는 조회하면 null, 삭제해도 에러가 나지 않는다', async () => {
    expect(await service.getRecover('none')).toBeNull();
    await expect(service.removeRecover('none')).resolves.toBeUndefined();
  });
});
