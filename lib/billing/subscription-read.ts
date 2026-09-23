import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, organizationSubscriptions } from "@/lib/db/schema";

/**
 * The org's stored subscription row, or undefined when it has none.
 *
 * Its own module so the quota-notification path can re-read the plan without
 * importing plans-server, which imports the notification path back.
 */
export async function getOrgSubscription(
  organizationId: string
): Promise<typeof organizationSubscriptions.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, organizationId))
    .limit(1);
  return rows[0];
}

export type OrgSubscriptionRead = {
  /** False means the read itself is untrustworthy, not that the org is free. */
  orgExists: boolean;
  subscription: typeof organizationSubscriptions.$inferSelect | null;
};

/**
 * The org's subscription resolved through its organization row.
 *
 * getOrgSubscription cannot tell "this org has no subscription" from "this
 * read returned nothing", and callers collapse both to the free plan, which is
 * also a real plan. Joining from organization makes the difference observable:
 * the org row has to come back before an absent subscription means anything.
 */
export async function readOrgSubscription(
  organizationId: string
): Promise<OrgSubscriptionRead> {
  const rows = await db
    .select({
      orgId: organization.id,
      subscription: organizationSubscriptions,
    })
    .from(organization)
    .leftJoin(
      organizationSubscriptions,
      eq(organizationSubscriptions.organizationId, organization.id)
    )
    .where(eq(organization.id, organizationId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { orgExists: false, subscription: null };
  }
  return { orgExists: true, subscription: row.subscription };
}
