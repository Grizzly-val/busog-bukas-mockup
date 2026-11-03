import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';

/**
 * Shared MySQL pool for the local XAMPP `busog_bukas` database.
 *
 * Driver settings:
 * - `dateStrings: true`  → DATE / DATETIME come back as plain strings
 *   ('2026-10-15', '2026-10-15 08:00:00'), so no timezone shifting happens.
 * - `decimalNumbers: true` → DECIMAL columns (weight_kg, bmi_change, ...) are JS numbers.
 * - `timezone: '+08:00'` → Asia/Manila, matching the mock data.
 *
 * The pool is cached on `globalThis` so Next.js dev hot reloads don't open a new
 * pool (and exhaust connections) on every edit.
 */
const globalForDb = globalThis as unknown as { __busogPool?: Pool };

function createPool(): Pool {
  return mysql.createPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'busog_bukas',
    charset: 'utf8mb4',
    timezone: '+08:00',
    dateStrings: true,
    decimalNumbers: true,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
}

export const pool: Pool = globalForDb.__busogPool ?? createPool();
if (process.env.NODE_ENV !== 'production') globalForDb.__busogPool = pool;

/** Run a SELECT and return typed rows. */
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows as unknown as T[];
}

/**
 * Run `fn` inside a single transaction on a dedicated connection.
 * Commits when `fn` resolves, rolls back (and rethrows) when it throws.
 */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
