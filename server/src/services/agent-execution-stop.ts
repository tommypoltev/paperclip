import os from "node:os";
import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, getTableColumns, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  if (!agentIds.length) return true;
  // Every historical run of the agent is scanned here; a full-row select drags result_json (Codex
  // stdout/stderr, megabytes per run) and context_snapshot for tens of thousands of rows and OOMs
  // the server while pausing an agent. Keep the columns the checks below read, drop the payloads.
  const { resultJson: _resultJson, contextSnapshot: _contextSnapshot, stdoutExcerpt: _stdoutExcerpt,
    stderrExcerpt: _stderrExcerpt, usageJson: _usageJson, ...lightRunColumns } = getTableColumns(heartbeatRuns);
  const runs = await db.select({
    ...lightRunColumns,
    resultJson: sql<(typeof heartbeatRuns.$inferSelect)["resultJson"]>`${heartbeatRuns.resultJson} - 'stdout' - 'stderr'`,
    contextSnapshot: sql<(typeof heartbeatRuns.$inferSelect)["contextSnapshot"]>`null`,
    stdoutExcerpt: sql<(typeof heartbeatRuns.$inferSelect)["stdoutExcerpt"]>`null`,
    stderrExcerpt: sql<(typeof heartbeatRuns.$inferSelect)["stderrExcerpt"]>`null`,
    usageJson: sql<(typeof heartbeatRuns.$inferSelect)["usageJson"]>`null`,
  }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  // Anything that started before the last host boot cannot still be running; a live pid/pgid there is
  // an unrelated process that reused the number (macOS recycles pids/pgids after reboot).
  const bootedAt = new Date(Date.now() - os.uptime() * 1000);
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return false;
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return false;
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return false;
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return false;
      continue;
    }
    // Nothing that ran before the last host boot can still be executing locally. Skip the pid/pgid and
    // cancellation-settlement checks for such runs: they trip on reused pids/pgids and on historical
    // cancellations that were never acknowledged, and keep the agent in "pausing" forever.
    const lastSeen = run.processStartedAt ?? run.finishedAt ?? run.startedAt;
    if (lastSeen && lastSeen < bootedAt) continue;
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return false;
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return false;
  }
  return true;
}
