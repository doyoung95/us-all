import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Config, JsonDB } from 'node-json-db';
import { RuntimeService } from '../common/runtime/runtime.service.js';
import { random } from '../util/random.js';
import {
  CreateJob,
  EditJob,
  EditJobProperty,
  Job,
  JobStatus,
  SearchJobQuery,
} from './types/jobs.types.js';

@Injectable()
export class JobsService {
  private readonly db = new JsonDB(new Config('data/jobs', true, false, '/'));
  constructor(private runtimeSVC: RuntimeService) {}

  async create(data: CreateJob) {
    try {
      await this.db.push('/list[]', {
        id: randomUUID(),
        title: data.title,
        description: data.description,
        status: JobStatus.waiting,
        reservationTime: random(1, 10),
        processingTime: random(5, 20) + this.runtimeSVC.getRunningSec(),
      });
    } catch (error) {
      console.error(error);
    }
  }

  getJobs() {
    return this.db.getData(`/list`);
  }

  async searchJobs(query: SearchJobQuery) {
    const { title, status } = query;
    const list = (await this.getJobs()) as Job[];
    if (!title && !status) return list;

    return list.filter((job) => {
      if (title && !job.title.includes(title)) {
        return false;
      }
      if (status && job.status !== status) {
        return false;
      }
      return true;
    });
  }

  async getJob(id: string) {
    const idx = await this.db.getIndex('/list', id);
    if (idx === -1) {
      throw new NotFoundException();
    }
    const job = await this.db.getData(`/list[${idx}]`);
    return {
      idx,
      job,
    };
  }

  private async editProperty(idx: number, data: EditJobProperty) {
    const patchData = Object.fromEntries(
      Object.entries(data).filter(([_, value]) => value !== undefined),
    );

    await this.db.push(`/list[${idx}]`, patchData, true);
  }

  private async editStatus(idx: number, status: JobStatus) {
    await this.db.push(`/list[${idx}]`, { status }, true);
  }

  // TODO lock 필요
  async editJob(id: string, data: EditJob) {
    const { title, description, status } = data;
    const { idx } = await this.getJob(id);
    if (title !== undefined || description !== undefined) {
      await this.editProperty(idx, { title, description });
    }

    if (status !== undefined && status in Object.values(JobStatus)) {
      await this.editStatus(idx, status);
    }
  }
}
