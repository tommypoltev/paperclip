import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { legacyRunCapacityAvailable } from "./run-capacity.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("global legacy run capacity", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("run-capacity"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(() => vi.unstubAllEnvs());
  async function seed() {
    const [company] = await db.insert(companies).values({ name: "capacity", issuePrefix: randomUUID() }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "agent", role: "engineer", adapterType: "process" }).returning();
    return (await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "queued", invocationSource: "assignment", runtimeMode: "legacy" }).returning())[0];
  }
  async function claim(run: Awaited<ReturnType<typeof seed>>) {
    return db.transaction(async tx => {
      if (!(await legacyRunCapacityAvailable(tx, run.runtimeMode))) return false;
      await tx.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, run.id));
      return true;
    });
  }
  it("serializes cross-company claims, keeps excess queued, then admits after completion", async () => {
    vi.stubEnv("PAPERCLIP_MAX_CONCURRENT_RUNS", "1");
    const runs = await Promise.all([seed(), seed()]);
    const results = await Promise.all(runs.map(claim));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = runs[results.indexOf(true)], waiting = runs[results.indexOf(false)];
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waiting.id)))[0].status).toBe("queued");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, winner.id));
    expect(await claim(waiting)).toBe(true);
  });
  it("is unlimited by default and excludes native claims", async () => {
    vi.stubEnv("PAPERCLIP_MAX_CONCURRENT_RUNS", "");
    expect(await claim(await seed())).toBe(true);
    vi.stubEnv("PAPERCLIP_MAX_CONCURRENT_RUNS", "1");
    expect(await db.transaction(tx => legacyRunCapacityAvailable(tx, "native"))).toBe(true);
  });
});
