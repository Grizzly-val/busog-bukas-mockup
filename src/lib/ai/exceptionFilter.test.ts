import { describe, it, expect, vi } from 'vitest';
import { fetchTimelinePayload } from './exceptionFilter';

// Mock prisma client
const mockPrisma = vi.hoisted(() => ({
  session: {
    findMany: vi.fn()
  }
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    session = mockPrisma.session;
  }
}));

describe('fetchTimelinePayload', () => {
  it('groups correctly and returns top 10 ON_TRACK and all ACTION_REQUIRED', async () => {
    // Mock data
    mockPrisma.session.findMany.mockResolvedValue([
      {
        id: 'session-1',
        timelineId: 'timeline-1',
        date: new Date('2026-10-01'),
        measurements: [
          { beneficiaryId: 'b-1', weight: 10, height: 100, statusFlag: 'ON_TRACK', beneficiary: { mnemonic_id: 'BOY-1' } },
          { beneficiaryId: 'b-2', weight: 12, height: 105, statusFlag: 'ON_TRACK', beneficiary: { mnemonic_id: 'BOY-2' } },
          { beneficiaryId: 'b-3', weight: 15, height: 110, statusFlag: 'ACTION_REQUIRED', beneficiary: { mnemonic_id: 'BOY-3' } }
        ]
      },
      {
        id: 'session-2',
        timelineId: 'timeline-1',
        date: new Date('2026-10-08'),
        measurements: [
          { beneficiaryId: 'b-1', weight: 11, height: 100, statusFlag: 'ON_TRACK', beneficiary: { mnemonic_id: 'BOY-1' } }, // gained 1
          { beneficiaryId: 'b-2', weight: 14, height: 105, statusFlag: 'ON_TRACK', beneficiary: { mnemonic_id: 'BOY-2' } }, // gained 2
          { beneficiaryId: 'b-3', weight: 14.5, height: 110, statusFlag: 'ACTION_REQUIRED', beneficiary: { mnemonic_id: 'BOY-3' } } // lost 0.5
        ]
      }
    ]);

    const payload = await fetchTimelinePayload('timeline-1');

    expect(payload.summary.totalParticipants).toBe(3);
    expect(payload.summary.totalSessions).toBe(2);
    expect(payload.summary.onTrackCount).toBe(2);
    expect(payload.summary.actionRequiredCount).toBe(1);

    // b-2 gained 2, b-1 gained 1, so b-2 should be first in top10OnTrack
    expect(payload.top10OnTrack[0].mnemonic_id).toBe('BOY-2');
    expect(payload.top10OnTrack[0].gain).toBe(2);
    expect(payload.top10OnTrack[1].mnemonic_id).toBe('BOY-1');
    expect(payload.top10OnTrack[1].gain).toBe(1);

    expect(payload.actionRequired[0].mnemonic_id).toBe('BOY-3');
    expect(payload.actionRequired[0].status).toBe('ACTION_REQUIRED');
  });
});
