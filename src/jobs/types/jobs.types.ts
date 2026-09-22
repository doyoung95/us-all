export enum JobStatus {
  waiting = 'waiting',
  pending = 'pending',
  completed = 'completed',
  canceled = 'canceled',
}

export type Job = {
  id: string;
  version: number;
  title: string;
  description?: string;
  status: JobStatus;

  // 서버 시작 후 몇 sec 뒤에 실행 가능한지
  reservationTime: number;
  // 처리하는데 걸리는 sec
  processingTime: number;
};

export type CreateJob = {
  title: string;
  description?: string;
};

export type SearchJobQuery = {
  title?: string;
  status?: JobStatus;
};

export type EditJobProperty = {
  version: number;
  title?: string;
  description?: string;
};

export type UpdateJobData = Partial<Omit<Job, 'id' | 'version'>>;
