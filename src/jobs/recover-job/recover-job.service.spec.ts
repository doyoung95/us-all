import { Test, TestingModule } from '@nestjs/testing';
import { RecoverJobService } from './recover-job.service.js';

describe('RecoverJobService', () => {
  let service: RecoverJobService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RecoverJobService],
    }).compile();

    service = module.get<RecoverJobService>(RecoverJobService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
