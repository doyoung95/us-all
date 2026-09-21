import { JobStatus } from './types/jobs.types.js';

export const JOB_STATUS_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  [JobStatus.canceled]: [JobStatus.waiting],
  [JobStatus.waiting]: [JobStatus.canceled],
  [JobStatus.pending]: [JobStatus.canceled],
  [JobStatus.completed]: [],
};

export const JOB_RECOVER_STATUS_TRANSITIONS: Record<
  JobStatus,
  JobStatus | null
> = {
  [JobStatus.canceled]: JobStatus.canceled,
  [JobStatus.pending]: JobStatus.waiting,
  [JobStatus.waiting]: null,
  [JobStatus.completed]: null,
};
