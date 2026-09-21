import { JobStatus } from './types/jobs.types.js';

export const JOB_RECOVER_STATUS_TRANSITIONS: Record<
  JobStatus,
  JobStatus | null
> = {
  [JobStatus.canceled]: JobStatus.canceled,
  [JobStatus.pending]: JobStatus.waiting,
  [JobStatus.waiting]: null,
  [JobStatus.completed]: null,
};
