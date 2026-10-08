import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    
    const { programId, timelineId, session, beneficiaries, measurements } = payload;

    if (!programId || !timelineId || !session || !measurements) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const beneficiaryMap = new Map<string, string>(); // code -> id
      
      // Upsert Beneficiaries
      if (beneficiaries && Array.isArray(beneficiaries)) {
        for (const b of beneficiaries) {
          const upserted = await tx.beneficiary.upsert({
            where: { beneficiary_code: b.beneficiary_code },
            update: {
              name: b.name || null,
              mnemonic_id: b.mnemonic_id,
            },
            create: {
              beneficiary_code: b.beneficiary_code,
              name: b.name || null,
              mnemonic_id: b.mnemonic_id,
              programId: programId,
            }
          });
          beneficiaryMap.set(b.beneficiary_code, upserted.id);
        }
      }

      // Lookup missing beneficiary IDs from DB if they weren't in the payload's beneficiaries array
      const missingCodes = measurements
        .map((m: any) => m.beneficiary_code)
        .filter((code: string) => !beneficiaryMap.has(code));
        
      if (missingCodes.length > 0) {
        const existing = await tx.beneficiary.findMany({
          where: { beneficiary_code: { in: missingCodes } }
        });
        for (const b of existing) {
          beneficiaryMap.set(b.beneficiary_code, b.id);
        }
      }

      // Create Session
      const createdSession = await tx.session.create({
        data: {
          name: session.name,
          date: new Date(session.date),
          timelineId: timelineId,
        }
      });

      // Prepare Measurements
      const measurementData = measurements.map((m: any) => {
        const bId = beneficiaryMap.get(m.beneficiary_code);
        if (!bId) throw new Error(`Beneficiary not found for code: ${m.beneficiary_code}`);
        return {
          weight: m.weight,
          height: m.height,
          statusFlag: m.statusFlag || 'ON_TRACK',
          beneficiaryId: bId,
          sessionId: createdSession.id,
        };
      });

      // Insert Measurements
      if (measurementData.length > 0) {
        await tx.measurementRecord.createMany({
          data: measurementData
        });
      }

      return { sessionId: createdSession.id, measurementsCount: measurementData.length };
    });

    return NextResponse.json({ success: true, ...result }, { status: 200 });

  } catch (error: any) {
    console.error('Sync Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
