import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "../db";
import {
  createMnemonicId,
  SyncRequestError,
  type SyncPayload,
} from "./payload";

export interface SyncResult {
  sessionId: string;
  sessionReference: string;
  beneficiariesSynced: number;
  measurementsSynced: number;
}

export async function syncOfflinePayload(payload: SyncPayload): Promise<SyncResult> {
  return prisma.$transaction(async (tx) => applySync(tx, payload));
}

async function applySync(
  tx: Prisma.TransactionClient,
  payload: SyncPayload,
): Promise<SyncResult> {
  const timeline = await tx.timeline.findUnique({
    where: { id: payload.timelineId },
    select: { programId: true },
  });

  if (!timeline) {
    throw new SyncRequestError("Timeline was not found", 404, "TIMELINE_NOT_FOUND");
  }
  if (timeline.programId !== payload.programId) {
    throw new SyncRequestError(
      "Timeline does not belong to the supplied program",
      409,
      "PROGRAM_TIMELINE_CONFLICT",
    );
  }

  const requestedCodes = Array.from(
    new Set([
      ...payload.beneficiaries.map((entry) => entry.beneficiaryCode),
      ...payload.measurements.map((entry) => entry.beneficiaryCode),
    ]),
  );
  const existingBeneficiaries = await tx.beneficiary.findMany({
    where: { beneficiary_code: { in: requestedCodes } },
    select: { id: true, beneficiary_code: true, programId: true, mnemonic_id: true },
  });

  const crossProgramBeneficiary = existingBeneficiaries.find(
    (entry) => entry.programId !== payload.programId,
  );
  if (crossProgramBeneficiary) {
    throw new SyncRequestError(
      `Beneficiary code belongs to a different program: ${crossProgramBeneficiary.beneficiary_code}`,
      409,
      "BENEFICIARY_PROGRAM_CONFLICT",
    );
  }

  const beneficiaryIds = new Map(
    existingBeneficiaries.map((entry) => [entry.beneficiary_code, entry.id]),
  );
  const existingByCode = new Map(
    existingBeneficiaries.map((entry) => [entry.beneficiary_code, entry]),
  );

  for (const input of payload.beneficiaries) {
    const existing = existingByCode.get(input.beneficiaryCode);
    const mnemonicId =
      input.mnemonicId ?? existing?.mnemonic_id ?? createMnemonicId(input.beneficiaryCode);
    const update: Prisma.BeneficiaryUpdateInput = { mnemonic_id: mnemonicId };
    if (input.name !== undefined) update.name = input.name;

    const beneficiary = await tx.beneficiary.upsert({
      where: { beneficiary_code: input.beneficiaryCode },
      update,
      create: {
        beneficiary_code: input.beneficiaryCode,
        name: input.name ?? null,
        mnemonic_id: mnemonicId,
        programId: payload.programId,
      },
      select: { id: true },
    });
    beneficiaryIds.set(input.beneficiaryCode, beneficiary.id);
  }

  const missingCodes = payload.measurements
    .map((entry) => entry.beneficiaryCode)
    .filter((code) => !beneficiaryIds.has(code));
  if (missingCodes.length > 0) {
    throw new SyncRequestError(
      `Unknown beneficiary codes: ${missingCodes.join(", ")}`,
      400,
      "UNKNOWN_BENEFICIARY",
    );
  }

  const existingSession = await tx.session.findUnique({
    where: { clientReference: payload.session.clientReference },
    select: { id: true, timelineId: true },
  });
  if (existingSession && existingSession.timelineId !== payload.timelineId) {
    throw new SyncRequestError(
      "Session reference belongs to a different timeline",
      409,
      "SESSION_TIMELINE_CONFLICT",
    );
  }

  const session = await tx.session.upsert({
    where: { clientReference: payload.session.clientReference },
    update: {
      name: payload.session.name,
      date: payload.session.date,
    },
    create: {
      clientReference: payload.session.clientReference,
      name: payload.session.name,
      date: payload.session.date,
      timelineId: payload.timelineId,
    },
    select: { id: true },
  });

  for (const measurement of payload.measurements) {
    const beneficiaryId = beneficiaryIds.get(measurement.beneficiaryCode);
    if (!beneficiaryId) {
      throw new SyncRequestError(
        `Unknown beneficiary code: ${measurement.beneficiaryCode}`,
        400,
        "UNKNOWN_BENEFICIARY",
      );
    }

    await tx.measurementRecord.upsert({
      where: {
        sessionId_beneficiaryId: {
          sessionId: session.id,
          beneficiaryId,
        },
      },
      update: {
        weight: measurement.weight,
        height: measurement.height,
        statusFlag: measurement.statusFlag,
      },
      create: {
        weight: measurement.weight,
        height: measurement.height,
        statusFlag: measurement.statusFlag,
        beneficiaryId,
        sessionId: session.id,
      },
    });
  }

  return {
    sessionId: session.id,
    sessionReference: payload.session.clientReference,
    beneficiariesSynced: payload.beneficiaries.length,
    measurementsSynced: payload.measurements.length,
  };
}
