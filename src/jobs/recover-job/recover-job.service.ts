import { Injectable } from '@nestjs/common';
import { Config, JsonDB } from 'node-json-db';
import { Job } from '../types/jobs.types.js';

@Injectable()
export class RecoverJobService {
  private readonly db = new JsonDB(
    new Config('data/recovers', true, false, '/'),
  );
  constructor() {}

  // TODO 사용하지 않는 찌거기 리커버 데이터 cleanup

  async onModuleInit() {
    try {
      await this.db.getData('/list');
    } catch {
      await this.db.push('/list', {});
    }
  }

  async genRecover(originJob: Job) {
    await this.db.push(`/list/${originJob.id}`, originJob, true);
  }

  async getRecover(id: string) {
    try {
      return await this.db.getData(`/list/${id}`);
    } catch {
      return null;
    }
  }

  async removeRecover(id: string) {
    try {
      await this.db.delete(`/list/${id}`);
    } catch {}
  }
}
