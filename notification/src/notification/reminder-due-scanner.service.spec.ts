import { ObjectId } from 'mongodb';
import { ReminderDueScannerService } from './reminder-due-scanner.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';
import type { ActivityClaimService } from '../activity/activity-claim.service';
import type { NotificationService } from './notification.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { MetricsService } from '../metrics/metrics.service';

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared') as Record<string, unknown>;
  return {
    ...actual,
    getNotificationEventSpec: jest.fn(() => ({
      eventType: 'crm.activity.reminder',
      moduleId: 'activities',
      category: 'activities',
      severity: 'important',
      defaultChannels: ['in_app'],
    })),
  };
});

describe('ReminderDueScannerService (NFR-ACT-050)', () => {
  it('delivers due reminder and records lag metric', async () => {
    const id = new ObjectId();
    const fireAt = Date.now() - 5_000;
    const row = {
      _id: id,
      project_id: 'p1',
      activity_id: 'a1',
      recipient_id: 'u1',
      fire_at: fireAt,
      payload_json: JSON.stringify({ activityId: 'a1', title: 'Task', type: 'task' }),
      reminder_key: 'activity.reminder:a1',
      dedup_key: 'k1',
      status: 'pending' as const,
      created_at: fireAt - 1,
      updated_at: fireAt - 1,
    };
    const scheduled = {
      findDueCandidates: jest.fn().mockResolvedValue([row]),
      claimDue: jest.fn().mockResolvedValue(row),
      releaseClaim: jest.fn(),
      markCancelled: jest.fn(),
    } as unknown as ScheduledReminderService;
    const activityClaim = {
      claimReminderFire: jest.fn().mockResolvedValue({ claimed: true }),
      releaseReminderFire: jest.fn(),
    } as unknown as ActivityClaimService;
    const materialize = jest.fn().mockResolvedValue(true);
    const notifications = { materialize } as unknown as NotificationService;
    const members = {
      getEffectiveModulesWithStatus: jest
        .fn()
        .mockResolvedValue({ modules: ['activities'], ok: true }),
      getMembersWithStatus: jest
        .fn()
        .mockResolvedValue({ members: [{ id: 'u1', role: 'member' }], ok: true }),
      isModuleEnabled: jest.fn(() => true),
    } as unknown as ControlMembersService;
    const metrics = {
      observeReminderDeliveryLag: jest.fn(),
      recordSuppressed: jest.fn(),
    } as unknown as MetricsService;
    const scanner = new ReminderDueScannerService(
      scheduled,
      activityClaim,
      notifications,
      members,
      metrics,
    );
    const result = await scanner.sweep();
    expect(result.delivered).toBe(1);
    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'crm.activity.reminder',
        user_id: 'u1',
        project_id: 'p1',
      }),
    );
    expect(metrics.observeReminderDeliveryLag).toHaveBeenCalledWith(expect.any(Number));
  });

  it('releases claim when activity gRPC is unavailable (does not cancel)', async () => {
    const id = new ObjectId();
    const fireAt = Date.now() - 1_000;
    const row = {
      _id: id,
      project_id: 'p1',
      activity_id: 'a1',
      recipient_id: 'u1',
      fire_at: fireAt,
      payload_json: '{}',
    };
    const scheduled = {
      findDueCandidates: jest.fn().mockResolvedValue([row]),
      claimDue: jest.fn().mockResolvedValue(row),
      releaseClaim: jest.fn(),
      markCancelled: jest.fn(),
    } as unknown as ScheduledReminderService;
    const activityClaim = {
      claimReminderFire: jest.fn().mockRejectedValue(new Error('ACTIVITY_UNAVAILABLE')),
      releaseReminderFire: jest.fn(),
    } as unknown as ActivityClaimService;
    const scanner = new ReminderDueScannerService(
      scheduled,
      activityClaim,
      { materialize: jest.fn() } as unknown as NotificationService,
      {
        getEffectiveModulesWithStatus: jest
          .fn()
          .mockResolvedValue({ modules: ['activities'], ok: true }),
        getMembersWithStatus: jest.fn().mockResolvedValue({ members: [{ id: 'u1' }], ok: true }),
        isModuleEnabled: jest.fn(() => true),
      } as unknown as ControlMembersService,
      {
        observeReminderDeliveryLag: jest.fn(),
        recordSuppressed: jest.fn(),
      } as unknown as MetricsService,
    );
    await expect(scanner.sweep()).resolves.toEqual({ delivered: 0 });
    expect(scheduled.releaseClaim).toHaveBeenCalledWith(id);
    expect(scheduled.markCancelled).not.toHaveBeenCalled();
  });

  it('cancels when recipient is no longer a project member', async () => {
    const id = new ObjectId();
    const row = {
      _id: id,
      project_id: 'p1',
      activity_id: 'a1',
      recipient_id: 'u-gone',
      fire_at: Date.now() - 1_000,
      payload_json: '{}',
    };
    const scheduled = {
      findDueCandidates: jest.fn().mockResolvedValue([row]),
      claimDue: jest.fn().mockResolvedValue(row),
      releaseClaim: jest.fn(),
      markCancelled: jest.fn(),
    } as unknown as ScheduledReminderService;
    const activityClaim = {
      claimReminderFire: jest.fn(),
      releaseReminderFire: jest.fn(),
    } as unknown as ActivityClaimService;
    const metrics = { observeReminderDeliveryLag: jest.fn(), recordSuppressed: jest.fn() };
    const scanner = new ReminderDueScannerService(
      scheduled,
      activityClaim,
      { materialize: jest.fn() } as unknown as NotificationService,
      {
        getEffectiveModulesWithStatus: jest
          .fn()
          .mockResolvedValue({ modules: ['activities'], ok: true }),
        getMembersWithStatus: jest.fn().mockResolvedValue({ members: [{ id: 'u1' }], ok: true }),
        isModuleEnabled: jest.fn(() => true),
      } as unknown as ControlMembersService,
      metrics as unknown as MetricsService,
    );
    await expect(scanner.sweep()).resolves.toEqual({ delivered: 0 });
    expect(scheduled.markCancelled).toHaveBeenCalledWith(id);
    expect(activityClaim.claimReminderFire).not.toHaveBeenCalled();
    expect(metrics.recordSuppressed).toHaveBeenCalledWith('not_a_member');
  });

  it('cancels when activities module is disabled in the project', async () => {
    const id = new ObjectId();
    const row = {
      _id: id,
      project_id: 'p1',
      activity_id: 'a1',
      recipient_id: 'u1',
      fire_at: Date.now() - 1_000,
      payload_json: '{}',
    };
    const scheduled = {
      findDueCandidates: jest.fn().mockResolvedValue([row]),
      claimDue: jest.fn().mockResolvedValue(row),
      releaseClaim: jest.fn(),
      markCancelled: jest.fn(),
    } as unknown as ScheduledReminderService;
    const metrics = { observeReminderDeliveryLag: jest.fn(), recordSuppressed: jest.fn() };
    const scanner = new ReminderDueScannerService(
      scheduled,
      {
        claimReminderFire: jest.fn(),
        releaseReminderFire: jest.fn(),
      } as unknown as ActivityClaimService,
      { materialize: jest.fn() } as unknown as NotificationService,
      {
        getEffectiveModulesWithStatus: jest
          .fn()
          .mockResolvedValue({ modules: ['deals'], ok: true }),
        getMembersWithStatus: jest.fn(),
        isModuleEnabled: jest.fn(() => false),
      } as unknown as ControlMembersService,
      metrics as unknown as MetricsService,
    );
    await expect(scanner.sweep()).resolves.toEqual({ delivered: 0 });
    expect(scheduled.markCancelled).toHaveBeenCalledWith(id);
    expect(metrics.recordSuppressed).toHaveBeenCalledWith('module_disabled');
  });

  it('releases claim when control modules lookup is unavailable', async () => {
    const id = new ObjectId();
    const row = {
      _id: id,
      project_id: 'p1',
      activity_id: 'a1',
      recipient_id: 'u1',
      fire_at: Date.now() - 1_000,
      payload_json: '{}',
    };
    const scheduled = {
      findDueCandidates: jest.fn().mockResolvedValue([row]),
      claimDue: jest.fn().mockResolvedValue(row),
      releaseClaim: jest.fn(),
      markCancelled: jest.fn(),
    } as unknown as ScheduledReminderService;
    const scanner = new ReminderDueScannerService(
      scheduled,
      {
        claimReminderFire: jest.fn(),
        releaseReminderFire: jest.fn(),
      } as unknown as ActivityClaimService,
      { materialize: jest.fn() } as unknown as NotificationService,
      {
        getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: [], ok: false }),
        getMembersWithStatus: jest.fn(),
        isModuleEnabled: jest.fn(),
      } as unknown as ControlMembersService,
      {
        observeReminderDeliveryLag: jest.fn(),
        recordSuppressed: jest.fn(),
      } as unknown as MetricsService,
    );
    await expect(scanner.sweep()).resolves.toEqual({ delivered: 0 });
    expect(scheduled.releaseClaim).toHaveBeenCalledWith(id);
  });
});
