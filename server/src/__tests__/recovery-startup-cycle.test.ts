import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issueRelations, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";
import * as disposition from "../services/recovery/disposition-repair.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("startup recovery cycle isolation", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("recovery-startup-cycle"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "recovery", issuePrefix: randomUUID() }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "agent", role: "engineer", adapterType: "process" }).returning();
    const [source] = await db.insert(issues).values({ companyId: company.id, title: "source", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [child] = await db.insert(issues).values({ companyId: company.id, title: "child", parentId: source.id, status: "in_progress", assigneeAgentId: agent.id }).returning();
    await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: child.id, status: "running", runtimeMode: "legacy", invocationSource: "assignment", contextSnapshot: { issueId: child.id } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: company.id, sourceIssueId: source.id, kind: "missing_disposition", ownerType: "board", cause: "successful_run_missing_issue_disposition", fingerprint: source.id, nextAction: "repair" }).returning();
    return { source, child, action, company };
  }
  it.each([false, true])("does not add a child reachable through blocks (transitive=%s)", async transitive => {
    const { source, child, company, action } = await fixture();
    const [middle] = await db.insert(issues).values({ companyId: company.id, title: "middle" }).returning();
    await db.insert(issueRelations).values(transitive ? [
      { companyId: company.id, issueId: source.id, relatedIssueId: middle.id, type: "blocks" },
      { companyId: company.id, issueId: middle.id, relatedIssueId: child.id, type: "blocks" },
    ] : [{ companyId: company.id, issueId: source.id, relatedIssueId: child.id, type: "blocks" }]);
    await expect(recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues({ issueCreatedAtGte: new Date("2100-01-01") })).resolves.toBeDefined();
    const links = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, source.id));
    expect(links).toHaveLength(0);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0].status).toBe("active");
  });
  it("logs/skips a failed action and still reconciles the following action", async () => {
    const first = await fixture(), second = await fixture();
    const original = disposition.collectDispositionRepairSourceState;
    const spy = vi.spyOn(disposition, "collectDispositionRepairSourceState").mockImplementation(async (database, input) => {
      if (input.issue.id === first.source.id) throw new Error("test action failure");
      return original(database, input);
    });
    try {
      await expect(recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues({ issueCreatedAtGte: new Date("2100-01-01") })).resolves.toMatchObject({ skipped: expect.any(Number) });
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, second.action.id)))[0].status).toBe("resolved");
    } finally { spy.mockRestore(); }
  });
});
