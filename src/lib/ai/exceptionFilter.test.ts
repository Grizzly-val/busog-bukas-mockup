import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockPrisma = vi.hoisted(() => ({
  session: {
    findMany: vi.fn(),
  },
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    session = mockPrisma.session;
  },
}));

import { fetchTimelinePayload } from "./exceptionFilter";

function measurement(
  beneficiaryId: string,
  weight: number,
  statusFlag: string,
) {
  return {
    beneficiaryId,
    weight,
    height: 100,
    statusFlag,
    beneficiary: {
      name: `Private ${beneficiaryId}`,
      mnemonic_id: `FIELD-${beneficiaryId}`,
    },
  };
}

describe("fetchTimelinePayload", () => {
  beforeEach(() => {
    mockPrisma.session.findMany.mockReset();
  });

  it("returns the top 10 positive deviants, every action-required record, and no field identifiers", async () => {
    const onTrack = Array.from({ length: 12 }, (_, index) => `b-${index + 1}`);
    mockPrisma.session.findMany.mockResolvedValue([
      {
        id: "session-1",
        date: new Date("2026-10-01"),
        measurements: [
          ...onTrack.map((id) => measurement(id, 10, "ON_TRACK")),
          measurement("b-action", 15, "ACTION_REQUIRED"),
          measurement("b-monitor", 11, "MONITOR_CLOSELY"),
        ],
      },
      {
        id: "session-2",
        date: new Date("2026-10-08"),
        measurements: [
          ...onTrack.map((id, index) => measurement(id, 11 + index, "ON_TRACK")),
          measurement("b-action", 14.5, "ACTION_REQUIRED"),
          measurement("b-monitor", 11.2, "MONITOR_CLOSELY"),
        ],
      },
    ]);

    const payload = await fetchTimelinePayload("timeline-1");

    expect(payload.summary).toMatchObject({
      totalParticipants: 14,
      totalSessions: 2,
      onTrackCount: 12,
      monitorCloselyCount: 1,
      actionRequiredCount: 1,
    });
    expect(payload.top10OnTrack).toHaveLength(10);
    expect(payload.top10OnTrack[0].weightGainKg).toBe(12);
    expect(payload.top10OnTrack[9].weightGainKg).toBe(3);
    expect(payload.actionRequired).toHaveLength(1);
    expect(payload.actionRequired[0]).toMatchObject({
      weightGainKg: -0.5,
      status: "ACTION_REQUIRED",
    });
    expect(payload.actionRequired[0].participantRef).toMatch(/^participant-[a-f0-9]{12}$/);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("FIELD-");
    expect(serialized).not.toContain("mnemonic_id");
  });
});
