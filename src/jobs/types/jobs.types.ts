export enum JobStatus {
  waiting = 'waiting',
  pending = 'pending',
  completed = 'completed',
}
export type Job = {
  id: string;
  title: string;
  description?: string;
  status: JobStatus;
};

export type CreateJob = {
  title: string;
  description?: string;
};

export type SearchJobQuery = {
  title?: string;
  status?: JobStatus;
};

export type EditJob = {
  title?: string;
  description?: string;
  status?: JobStatus;
};

export type EditJobProperty = {
  title?: string;
  description?: string;
};
