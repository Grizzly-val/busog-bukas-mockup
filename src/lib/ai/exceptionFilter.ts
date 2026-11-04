import "server-only";

import { createHash } from "node:crypto";

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { Prisma } from "@prisma/client";
import { generateText, type LanguageModel } from "ai";

import { prisma } from "../db";
import { exceptionFilterPrompt } from "./prompts";

type TimelineSession = Prisma.SessionGetPayload<{
  include: {
    measurements: {
      include: { beneficiary: true };
    };
  };
}>;

interface TimelineReader {
  session: {
    findMany(args: Prisma.SessionFindManyArgs): Promise<TimelineSession[]>;
  };
}

interface MeasurementSnapshot {
  beneficiaryId: string;
  weight: number;
  height: number;
  statusFlag: string;
}

export interface ExceptionFilterParticipant {
  participantRef: string;
  latestWeightKg: number;
  latestHeightCm: number;
  weightGainKg: number;
  bmiChange: number;
  status: string;
}

export interface ExceptionFilterPayload {
  summary: {
    totalParticipants: number;
    totalSessions: number;
    onTrackCount: number;
    monitorCloselyCount: number;
    actionRequiredCount: number;
    averageWeightGainKg: number;
    averageBmiChange: number;
  };
  top10OnTrack: ExceptionFilterParticipant[];
  actionRequired: ExceptionFilterParticipant[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function bmi(measurement: MeasurementSnapshot): number {
  const heightMeters = measurement.height / 100;
  return heightMeters > 0 ? measurement.weight / heightMeters ** 2 : 0;
}

function participantReference(timelineId: string, beneficiaryId: string): string {
  return `participant-${createHash("sha256")
    .update(`${timelineId}\u0000${beneficiaryId}`)
    .digest("hex")
    .slice(0, 12)}`;
}

export async function fetchTimelinePayload(
  timelineId: string,
  reader: TimelineReader = prisma as unknown as TimelineReader,
): Promise<ExceptionFilterPayload> {
  const sessions = await reader.session.findMany({
    where: { timelineId },
    include: {
      measurements: {
        include: { beneficiary: true },
      },
    },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });

  const firstByBeneficiary = new Map<string, MeasurementSnapshot>();
  const latestByBeneficiary = new Map<string, MeasurementSnapshot>();

  for (const session of sessions) {
    for (const measurement of session.measurements) {
      if (!firstByBeneficiary.has(measurement.beneficiaryId)) {
        firstByBeneficiary.set(measurement.beneficiaryId, measurement);
      }
      latestByBeneficiary.set(measurement.beneficiaryId, measurement);
    }
  }

  const participants = Array.from(latestByBeneficiary.values()).map((latest) => {
    const initial = firstByBeneficiary.get(latest.beneficiaryId) ?? latest;
    return {
      participantRef: participantReference(timelineId, latest.beneficiaryId),
      latestWeightKg: round(latest.weight),
      latestHeightCm: round(latest.height),
      weightGainKg: round(latest.weight - initial.weight),
      bmiChange: round(bmi(latest) - bmi(initial)),
      status: latest.statusFlag,
    } satisfies ExceptionFilterParticipant;
  });

  const onTrack = participants
    .filter((participant) => participant.status === "ON_TRACK")
    .sort((left, right) => right.weightGainKg - left.weightGainKg);
  const actionRequired = participants.filter(
    (participant) => participant.status === "ACTION_REQUIRED",
  );
  const monitorCloselyCount = participants.filter(
    (participant) => participant.status === "MONITOR_CLOSELY",
  ).length;
  const totalParticipants = participants.length;
  const totalWeightGain = participants.reduce(
    (sum, participant) => sum + participant.weightGainKg,
    0,
  );
  const totalBmiChange = participants.reduce(
    (sum, participant) => sum + participant.bmiChange,
    0,
  );

  return {
    summary: {
      totalParticipants,
      totalSessions: sessions.length,
      onTrackCount: onTrack.length,
      monitorCloselyCount,
      actionRequiredCount: actionRequired.length,
      averageWeightGainKg: totalParticipants ? round(totalWeightGain / totalParticipants) : 0,
      averageBmiChange: totalParticipants ? round(totalBmiChange / totalParticipants) : 0,
    },
    top10OnTrack: onTrack.slice(0, 10),
    actionRequired,
  };
}

function configuredModels(): Array<{ provider: string; model: LanguageModel }> {
  const models: Array<{ provider: string; model: LanguageModel }> = [];

  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    models.push({ provider: "google", model: google("gemini-2.5-flash") });
  }
  if (process.env.OPENAI_API_KEY) {
    models.push({ provider: "openai", model: openai("gpt-5-mini") });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    models.push({ provider: "anthropic", model: anthropic("claude-sonnet-4-5") });
  }

  return models;
}

export async function generateInterventionReport(timelineId: string): Promise<string> {
  const payload = await fetchTimelinePayload(timelineId);
  const models = configuredModels();

  if (models.length === 0) {
    throw new Error(
      "No AI provider is configured. Set GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
    );
  }

  for (const [index, candidate] of models.entries()) {
    try {
      const { text } = await generateText({
        model: candidate.model,
        system: exceptionFilterPrompt,
        prompt: `Analyze this de-identified cohort payload:\n\n${JSON.stringify(payload, null, 2)}`,
        temperature: 0.2,
        maxOutputTokens: 1_200,
      });
      return text;
    } catch (error: unknown) {
      console.warn(`Intervention report provider failed: ${candidate.provider}`, {
        attempt: index + 1,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  throw new Error("All configured AI providers failed to generate the intervention report.");
}
