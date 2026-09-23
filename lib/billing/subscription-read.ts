import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationSubscriptions } from "@/lib/db/schema";

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
