import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { PrismaClient } from '@prisma/client';
import { exceptionFilterPrompt } from './prompts';

const prisma = new PrismaClient();

export async function fetchTimelinePayload(timelineId: string) {
  const sessions = await prisma.session.findMany({
    where: { timelineId },
    include: {
      measurements: {
        include: {
          beneficiary: true,
        },
      },
    },
    orderBy: {
      date: 'asc'
    }
  });

  const totalSessions = sessions.length;
  
  const beneficiaryLatestMeasurement = new Map<string, any>();
  const beneficiaryInitialMeasurement = new Map<string, any>();

  for (const session of sessions) {
    for (const measurement of session.measurements) {
      const bId = measurement.beneficiaryId;
      if (!beneficiaryInitialMeasurement.has(bId)) {
        beneficiaryInitialMeasurement.set(bId, measurement);
      }
      beneficiaryLatestMeasurement.set(bId, measurement);
    }
  }

  const allLatest = Array.from(beneficiaryLatestMeasurement.values());
  const totalParticipants = allLatest.length;

  const onTrack = allLatest.filter(m => m.statusFlag === 'ON_TRACK');
  const actionRequired = allLatest.filter(m => m.statusFlag === 'ACTION_REQUIRED');

  const onTrackWithGain = onTrack.map(m => {
    const initial = beneficiaryInitialMeasurement.get(m.beneficiaryId);
    const gain = m.weight - initial.weight;
    return { ...m, gain };
  });

  onTrackWithGain.sort((a, b) => b.gain - a.gain);
  const top10OnTrack = onTrackWithGain.slice(0, 10);

  const payload = {
    summary: {
      totalParticipants,
      totalSessions,
      onTrackCount: onTrack.length,
      actionRequiredCount: actionRequired.length,
    },
    top10OnTrack: top10OnTrack.map(m => ({
      mnemonic_id: m.beneficiary.mnemonic_id,
      weight: m.weight,
      height: m.height,
      gain: m.gain,
      status: m.statusFlag,
    })),
    actionRequired: actionRequired.map(m => ({
      mnemonic_id: m.beneficiary.mnemonic_id,
      weight: m.weight,
      height: m.height,
      status: m.statusFlag,
    }))
  };

  return payload;
}

export async function generateInterventionReport(timelineId: string) {
  const payload = await fetchTimelinePayload(timelineId);

  const { text } = await generateText({
    model: google('gemini-1.5-flash'),
    system: exceptionFilterPrompt,
    prompt: `Analyze the following payload data for timeline ${timelineId}:\n\n${JSON.stringify(payload, null, 2)}`
  });

  return text;
}
