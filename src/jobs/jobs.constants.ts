import { JobStatus } from './types/jobs.types.js';

export const JOB_STATUS_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  [JobStatus.canceled]: [JobStatus.waiting],
  [JobStatus.waiting]: [JobStatus.canceled],
  [JobStatus.pending]: [JobStatus.canceled],
  [JobStatus.completed]: [],
};
