import "server-only";

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as typeof globalThis & {
  busogBukasPrisma?: PrismaClient;
};

export const prisma = globalForPrisma.busogBukasPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.busogBukasPrisma = prisma;
}
