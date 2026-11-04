import { describe, expect, it } from "vitest";

import {
  createMnemonicId,
  parseSyncPayload,
  SyncRequestError,
} from "./payload";

const validPayload = {
  programId: "program-1",
  timelineId: "timeline-1",
  session: {
    name: "Week 1",
    date: "2026-10-14T08:00:00.000Z",
  },
  beneficiaries: [
    {
      beneficiary_code: "BB-001",
      name: null,
    },
  ],
  measurements: [
    {
      beneficiary_code: "BB-001",
      weight: 18.4,
      height: 112,
      statusFlag: "MONITOR_CLOSELY",
    },
  ],
};

describe("parseSyncPayload", () => {
  it("normalizes a legacy payload and creates a stable retry reference", () => {
    const first = parseSyncPayload(validPayload);
    const retry = parseSyncPayload(validPayload);

    expect(first.session.clientReference).toBe(retry.session.clientReference);
    expect(first.session.clientReference).toMatch(/^legacy-[a-f0-9]{32}$/);
    expect(first.measurements[0].statusFlag).toBe("MONITOR_CLOSELY");
    expect(first.session.date).toEqual(new Date("2026-10-14T08:00:00.000Z"));
  });

  it("uses an explicit offline client reference when one is supplied", () => {
    const parsed = parseSyncPayload({
      ...validPayload,
      session: { ...validPayload.session, clientReference: "device-a:session-42" },
    });

    expect(parsed.session.clientReference).toBe("device-a:session-42");
  });

  it.each([
    {
      name: "invalid status",
      payload: {
        ...validPayload,
        measurements: [{ ...validPayload.measurements[0], statusFlag: "FAILING" }],
      },
    },
    {
      name: "negative measurement",
      payload: {
        ...validPayload,
        measurements: [{ ...validPayload.measurements[0], weight: -1 }],
      },
    },
    {
      name: "duplicate measurement",
      payload: {
        ...validPayload,
        measurements: [validPayload.measurements[0], validPayload.measurements[0]],
      },
    },
  ])("rejects $name", ({ payload }) => {
    expect(() => parseSyncPayload(payload)).toThrow(SyncRequestError);
  });
});

describe("createMnemonicId", () => {
  it("is deterministic and human-readable", () => {
    expect(createMnemonicId("BB-001")).toBe(createMnemonicId("BB-001"));
    expect(createMnemonicId("BB-001")).toMatch(/^[A-Z][a-z]+-[A-Z][a-z]+-\d{2}$/);
  });
});
