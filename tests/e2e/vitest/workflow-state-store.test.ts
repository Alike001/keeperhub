import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  organization,
  users,
  workflowState,
  workflows,
} from "../../../lib/db/schema";
import {
  getWorkflowStateValue,
  setWorkflowStateValue,
  WORKFLOW_STATE_LIMITS,
} from "../../../lib/workflow/nodes/workflow-state/store";

// tests/setup.ts globally mocks @/lib/db. The store takes its executor as a
// parameter, so this suite passes its own real handle.
vi.unmock("@/lib/db");
vi.mock("server-only", () => ({}));

// The compare-and-set and the key ceiling live in SQL (a versioned UPDATE and
// a count guarded by an advisory lock), so they are exercised against a real
// database rather than a mock.

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_workflow_state_";

describe.skipIf(SKIP)("workflow state store", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  const ownerId = `${PREFIX}user`;
  const orgId = `${PREFIX}org`;
  const workflowId = `${PREFIX}wf`;
  const scope = { organizationId: orgId, workflowId };

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function expireKey(key: string): Promise<void> {
    await db
      .update(workflowState)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(workflowState.workflowId, workflowId),
          eq(workflowState.key, key)
        )
      );
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL, { max: 20 });
    db = drizzle(queryClient);
    await cleanup();

    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@workflow-state.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organization).values({
      id: orgId,
      name: orgId,
      slug: orgId,
      createdAt: new Date(),
    });
    await db.insert(workflows).values({
      id: workflowId,
      name: workflowId,
      userId: ownerId,
      organizationId: orgId,
      nodes: [],
      edges: [],
      visibility: "private",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  beforeEach(async () => {
    await db
      .delete(workflowState)
      .where(eq(workflowState.workflowId, workflowId));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("reports a missing key with a null version", async () => {
    const result = await getWorkflowStateValue(scope, "missing", db);

    expect(result).toEqual({
      success: true,
      exists: false,
      value: null,
      version: null,
    });
  });

  it("creates, then overwrites with a version bump", async () => {
    const first = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 1 },
      db
    );
    const second = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 2 },
      db
    );

    expect(first).toEqual({ success: true, created: true, version: 1 });
    expect(second).toEqual({ success: true, created: false, version: 2 });
    expect(await getWorkflowStateValue(scope, "cursor", db)).toEqual({
      success: true,
      exists: true,
      value: 2,
      version: 2,
    });
  });

  it("applies a compare-and-set on the current version and rejects a stale one", async () => {
    await setWorkflowStateValue(scope, "cursor", { value: 1 }, db);

    const applied = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 2, expectedVersion: 1 },
      db
    );
    const stale = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 3, expectedVersion: 1 },
      db
    );

    expect(applied).toEqual({ success: true, created: false, version: 2 });
    expect(stale).toMatchObject({ success: false, reason: "conflict" });
    expect(await getWorkflowStateValue(scope, "cursor", db)).toMatchObject({
      value: 2,
      version: 2,
    });
  });

  it("reports replacing an expired key as a create", async () => {
    await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 1, ttlSeconds: 60 },
      db
    );
    await expireKey("cursor");

    const result = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 2 },
      db
    );

    expect(result).toMatchObject({ success: true, created: true });
  });

  it("keeps an expired row on read so a re-created key continues its version", async () => {
    await setWorkflowStateValue(scope, "cursor", { value: 1 }, db);
    await setWorkflowStateValue(scope, "cursor", { value: 2 }, db);
    await expireKey("cursor");

    expect(await getWorkflowStateValue(scope, "cursor", db)).toMatchObject({
      exists: false,
    });
    const [kept] = await db
      .select({ version: workflowState.version })
      .from(workflowState)
      .where(
        and(
          eq(workflowState.workflowId, workflowId),
          eq(workflowState.key, "cursor")
        )
      );
    expect(kept?.version).toBe(2);

    // A holder of version 2 from before the expiry must not match the
    // re-created key.
    const recreated = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 3 },
      db
    );
    const stale = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 4, expectedVersion: 2 },
      db
    );

    expect(recreated).toEqual({ success: true, created: true, version: 3 });
    expect(stale).toMatchObject({ success: false, reason: "conflict" });
  });

  it("holds the key ceiling under concurrent new-key writers", async () => {
    const max = WORKFLOW_STATE_LIMITS.MAX_KEYS_PER_WORKFLOW;
    await db.insert(workflowState).values(
      Array.from({ length: max - 1 }, (_, i) => ({
        organizationId: orgId,
        workflowId,
        key: `seed-${i}`,
        value: i,
      }))
    );

    // Each insert sleeps before it lands, so every writer's count runs while
    // the others' inserts are still uncommitted. Without the per-workflow
    // lock all of them read 99 and the workflow ends well past the ceiling.
    await queryClient.unsafe(`
      CREATE OR REPLACE FUNCTION ${PREFIX}slow_insert() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER ${PREFIX}slow_insert BEFORE INSERT ON workflow_state
        FOR EACH ROW EXECUTE FUNCTION ${PREFIX}slow_insert();
    `);

    const writers = 10;
    let results: Awaited<ReturnType<typeof setWorkflowStateValue>>[];
    try {
      results = await Promise.all(
        Array.from({ length: writers }, (_, i) =>
          setWorkflowStateValue(scope, `new-${i}`, { value: i }, db)
        )
      );
    } finally {
      await queryClient.unsafe(`
        DROP TRIGGER IF EXISTS ${PREFIX}slow_insert ON workflow_state;
        DROP FUNCTION IF EXISTS ${PREFIX}slow_insert();
      `);
    }

    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowState)
      .where(eq(workflowState.workflowId, workflowId));
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(
      results.filter((r) => !r.success && r.reason === "limit")
    ).toHaveLength(writers - 1);
    expect(row.count).toBe(max);
  });
});
