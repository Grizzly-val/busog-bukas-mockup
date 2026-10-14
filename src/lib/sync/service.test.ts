import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const tx = {
    timeline: { findUnique: vi.fn() },
    beneficiary: { findMany: vi.fn(), upsert: vi.fn() },
    session: { findUnique: vi.fn(), upsert: vi.fn() },
    measurementRecord: { upsert: vi.fn() },
  };
  return {
    tx,
    transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  };
});

vi.mock("../db", () => ({
  prisma: { $transaction: mocks.transaction },
}));

import { parseSyncPayload } from "./payload";
import { syncOfflinePayload } from "./service";

const body = {
  programId: "program-1",
  timelineId: "timeline-1",
  session: {
    clientReference: "device-a:session-42",
    name: "Week 1",
    date: "2026-10-14T08:00:00.000Z",
  },
  beneficiaries: [{ beneficiary_code: "BB-001", name: null }],
  measurements: [
    {
      beneficiary_code: "BB-001",
      weight: 18.4,
      height: 112,
      statusFlag: "ON_TRACK",
    },
  ],
};

describe("syncOfflinePayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.timeline.findUnique.mockResolvedValue({ programId: "program-1" });
    mocks.tx.beneficiary.findMany.mockResolvedValue([]);
    mocks.tx.beneficiary.upsert.mockResolvedValue({ id: "beneficiary-1" });
    mocks.tx.session.findUnique.mockResolvedValue(null);
    mocks.tx.session.upsert.mockResolvedValue({ id: "session-1" });
    mocks.tx.measurementRecord.upsert.mockResolvedValue({ id: "measurement-1" });
  });

  it("uses stable upsert keys so the same offline batch can be retried", async () => {
    const payload = parseSyncPayload(body);

    const first = await syncOfflinePayload(payload);
    const retry = await syncOfflinePayload(payload);

    expect(first.sessionId).toBe(retry.sessionId);
    expect(mocks.tx.session.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { clientReference: "device-a:session-42" },
      }),
    );
    expect(mocks.tx.session.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { clientReference: "device-a:session-42" },
      }),
    );
    expect(mocks.tx.measurementRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sessionId_beneficiaryId: {
            sessionId: "session-1",
            beneficiaryId: "beneficiary-1",
          },
        },
      }),
    );
  });

  it("rejects a timeline from another program before writing", async () => {
    mocks.tx.timeline.findUnique.mockResolvedValue({ programId: "program-2" });

    await expect(syncOfflinePayload(parseSyncPayload(body))).rejects.toMatchObject({
      status: 409,
      code: "PROGRAM_TIMELINE_CONFLICT",
    });
    expect(mocks.tx.beneficiary.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.session.upsert).not.toHaveBeenCalled();
  });
});
