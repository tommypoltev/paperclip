import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Call in the transaction that changes queued to running. Never wait while
 * holding issue/chat locks: a competing claim leaves this run queued for retry. */
export async function legacyRunCapacityAvailable(tx: Transaction, runtimeMode: string): Promise<boolean> {
  if (runtimeMode === "native") return true;
  const raw = process.env.PAPERCLIP_MAX_CONCURRENT_RUNS;
  const limit = Number(raw);
  if (!raw || !Number.isSafeInteger(limit) || limit <= 0) return true;
  const [lock] = await tx.execute<{ acquired: boolean }>(sql`
    select pg_try_advisory_xact_lock(hashtextextended('paperclip:legacy-run-capacity', 0)) as acquired`);
  if (!lock.acquired) return false;
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.status, "running"), ne(heartbeatRuns.runtimeMode, "native")));
  return row.count < limit;
}
