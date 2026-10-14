import { Prisma } from "@prisma/client";

import { parseSyncPayload, SyncRequestError } from "@/lib/sync/payload";
import { syncOfflinePayload } from "@/lib/sync/service";

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new SyncRequestError("Request body must be valid JSON", 400, "INVALID_JSON");
    }

    const payload = parseSyncPayload(body);
    const result = await syncOfflinePayload(payload);

    return Response.json({ success: true, ...result });
  } catch (error: unknown) {
    if (error instanceof SyncRequestError) {
      return Response.json(
        { success: false, error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return Response.json(
        {
          success: false,
          error: { code: "SYNC_CONFLICT", message: "A conflicting record already exists" },
        },
        { status: 409 },
      );
    }

    console.error("Unexpected sync error", error);
    return Response.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Unable to sync data" },
      },
      { status: 500 },
    );
  }
}
