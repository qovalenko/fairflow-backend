import { ObjectId } from 'mongodb';
import { OverdueScannerService } from './overdue-scanner.service';
import { ActivityService } from './activity.service';

describe('OverdueScannerService', () => {
  it('sweep publishes for each candidate', async () => {
    const publishOverdueEvent = jest.fn().mockResolvedValue(true);
    const findOverdueCandidates = jest.fn().mockResolvedValue([{ _id: new ObjectId() }]);
    const activity = {
      findOverdueCandidates,
      publishOverdueEvent,
    } as unknown as ActivityService;
    const scanner = new OverdueScannerService(activity);
    await expect(scanner.sweep()).resolves.toEqual({ published: 1 });
    expect(publishOverdueEvent).toHaveBeenCalledTimes(1);
  });
});
