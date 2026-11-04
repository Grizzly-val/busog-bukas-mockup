import { createHash } from "node:crypto";

export const STATUS_FLAGS = [
  "ON_TRACK",
  "MONITOR_CLOSELY",
  "ACTION_REQUIRED",
] as const;

export type StatusFlag = (typeof STATUS_FLAGS)[number];

export interface SyncBeneficiaryInput {
  beneficiaryCode: string;
  name?: string | null;
  mnemonicId?: string;
}

export interface SyncMeasurementInput {
  beneficiaryCode: string;
  weight: number;
  height: number;
  statusFlag: StatusFlag;
}

export interface SyncPayload {
  programId: string;
  timelineId: string;
  session: {
    clientReference: string;
    name: string;
    date: Date;
  };
  beneficiaries: SyncBeneficiaryInput[];
  measurements: SyncMeasurementInput[];
}

export class SyncRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "SyncRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 128,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SyncRequestError(`${field} is required`, 400, "INVALID_PAYLOAD");
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new SyncRequestError(
      `${field} must be ${maxLength} characters or fewer`,
      400,
      "INVALID_PAYLOAD",
    );
  }

  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maxLength);
}

function measurementNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new SyncRequestError(
      `${field} must be a positive finite number`,
      400,
      "INVALID_PAYLOAD",
    );
  }
  return value;
}

export function createSessionReference(input: {
  timelineId: string;
  name: string;
  date: Date;
}): string {
  return `legacy-${createHash("sha256")
    .update(`${input.timelineId}\u0000${input.name}\u0000${input.date.toISOString()}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export function createMnemonicId(beneficiaryCode: string): string {
  const colors = ["Blue", "Green", "Gold", "Orange", "Purple", "Silver"];
  const foods = ["Mango", "Coconut", "Papaya", "Rice", "Banana", "Corn"];
  const digest = createHash("sha256").update(beneficiaryCode).digest();
  const color = colors[digest[0] % colors.length];
  const food = foods[digest[1] % foods.length];
  const number = (digest.readUInt16BE(2) % 90) + 10;
  return `${color}-${food}-${number}`;
}

export function parseSyncPayload(value: unknown): SyncPayload {
  if (!isRecord(value)) {
    throw new SyncRequestError("Request body must be a JSON object", 400, "INVALID_PAYLOAD");
  }

  const programId = requiredString(value.programId, "programId");
  const timelineId = requiredString(value.timelineId, "timelineId");

  if (!isRecord(value.session)) {
    throw new SyncRequestError("session is required", 400, "INVALID_PAYLOAD");
  }

  const sessionName = requiredString(value.session.name, "session.name", 160);
  const rawDate = requiredString(value.session.date, "session.date", 64);
  const sessionDate = new Date(rawDate);
  if (Number.isNaN(sessionDate.getTime())) {
    throw new SyncRequestError(
      "session.date must be a valid ISO date",
      400,
      "INVALID_PAYLOAD",
    );
  }

  const suppliedReference = optionalString(
    value.session.clientReference ?? value.session.id,
    "session.clientReference",
    128,
  );
  const clientReference =
    suppliedReference ??
    createSessionReference({ timelineId, name: sessionName, date: sessionDate });

  const rawBeneficiaries = value.beneficiaries ?? [];
  if (!Array.isArray(rawBeneficiaries) || rawBeneficiaries.length > 5_000) {
    throw new SyncRequestError(
      "beneficiaries must be an array with at most 5000 entries",
      400,
      "INVALID_PAYLOAD",
    );
  }

  const beneficiaryCodes = new Set<string>();
  const beneficiaries = rawBeneficiaries.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new SyncRequestError(
        `beneficiaries[${index}] must be an object`,
        400,
        "INVALID_PAYLOAD",
      );
    }

    const beneficiaryCode = requiredString(
      entry.beneficiary_code ?? entry.beneficiaryCode,
      `beneficiaries[${index}].beneficiary_code`,
      80,
    );
    if (beneficiaryCodes.has(beneficiaryCode)) {
      throw new SyncRequestError(
        `Duplicate beneficiary code: ${beneficiaryCode}`,
        400,
        "INVALID_PAYLOAD",
      );
    }
    beneficiaryCodes.add(beneficiaryCode);

    let name: string | null | undefined;
    if (entry.name === null) name = null;
    else name = optionalString(entry.name, `beneficiaries[${index}].name`, 200);

    return {
      beneficiaryCode,
      name,
      mnemonicId: optionalString(
        entry.mnemonic_id ?? entry.mnemonicId,
        `beneficiaries[${index}].mnemonic_id`,
        120,
      ),
    };
  });

  if (!Array.isArray(value.measurements) || value.measurements.length === 0) {
    throw new SyncRequestError(
      "measurements must contain at least one entry",
      400,
      "INVALID_PAYLOAD",
    );
  }
  if (value.measurements.length > 5_000) {
    throw new SyncRequestError(
      "measurements must contain at most 5000 entries",
      400,
      "INVALID_PAYLOAD",
    );
  }

  const measuredCodes = new Set<string>();
  const measurements = value.measurements.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new SyncRequestError(
        `measurements[${index}] must be an object`,
        400,
        "INVALID_PAYLOAD",
      );
    }

    const beneficiaryCode = requiredString(
      entry.beneficiary_code ?? entry.beneficiaryCode,
      `measurements[${index}].beneficiary_code`,
      80,
    );
    if (measuredCodes.has(beneficiaryCode)) {
      throw new SyncRequestError(
        `Only one measurement per beneficiary is allowed in a session: ${beneficiaryCode}`,
        400,
        "INVALID_PAYLOAD",
      );
    }
    measuredCodes.add(beneficiaryCode);

    const rawStatus = entry.statusFlag ?? "ON_TRACK";
    if (
      typeof rawStatus !== "string" ||
      !STATUS_FLAGS.includes(rawStatus as StatusFlag)
    ) {
      throw new SyncRequestError(
        `measurements[${index}].statusFlag is invalid`,
        400,
        "INVALID_PAYLOAD",
      );
    }

    return {
      beneficiaryCode,
      weight: measurementNumber(entry.weight, `measurements[${index}].weight`),
      height: measurementNumber(entry.height, `measurements[${index}].height`),
      statusFlag: rawStatus as StatusFlag,
    };
  });

  return {
    programId,
    timelineId,
    session: { clientReference, name: sessionName, date: sessionDate },
    beneficiaries,
    measurements,
  };
}
