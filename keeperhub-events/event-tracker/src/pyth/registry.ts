import { randomUUID } from "node:crypto";
import { logger } from "../../lib/utils/logger";
import { abortableSleep } from "../listener/shutdown";
import { type PythRegistration, submitPythObservation } from "./client";
import { consumeHermesStream } from "./hermes-stream";

type Subscription = {
  registrations: PythRegistration[];
  controller: AbortController;
  task: Promise<void>;
};

export class PythRegistry {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly timer: ReturnType<typeof setInterval>;
  // The lease identity is per process, not per connection: a reconnect is the
  // same owner, so it keeps the lease and requests a fresh baseline explicitly.
  private readonly sessionId = randomUUID();
  private pendingTask: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly apiKey: string) {
    this.timer = setInterval(() => {
      if (!this.pendingTask && !this.stopped) {
        this.pendingTask = this.recoverPending().finally(() => {
          this.pendingTask = null;
        });
      }
    }, 5000);
  }

  async reconcile(registrations: PythRegistration[]): Promise<void> {
    if (this.stopped) {
      return;
    }
    const grouped = new Map<string, PythRegistration[]>();
    for (const registration of registrations) {
      const group = grouped.get(registration.feedId) ?? [];
      group.push(registration);
      grouped.set(registration.feedId, group);
    }
    for (const [feedId, subscription] of this.subscriptions) {
      if (!grouped.has(feedId)) {
        subscription.controller.abort();
        await subscription.task;
        this.subscriptions.delete(feedId);
      }
    }
    if (this.stopped) {
      return;
    }
    for (const [feedId, group] of grouped) {
      const existing = this.subscriptions.get(feedId);
      if (existing) {
        existing.registrations = group;
        continue;
      }
      const subscription: Subscription = {
        registrations: group,
        controller: new AbortController(),
        task: Promise.resolve(),
      };
      this.subscriptions.set(feedId, subscription);
      subscription.task = this.listen(feedId, subscription);
    }
  }

  private async recoverPending(): Promise<void> {
    for (const subscription of this.subscriptions.values()) {
      for (const registration of subscription.registrations) {
        if (this.stopped) {
          return;
        }
        try {
          await submitPythObservation(registration, this.sessionId);
        } catch {
          logger.warn(
            `[Pyth] pending dispatch recovery failed for ${registration.workflowId}; will retry`,
          );
        }
      }
    }
  }

  private async listen(
    feedId: string,
    subscription: Subscription,
  ): Promise<void> {
    let failures = 0;
    while (!subscription.controller.signal.aborted) {
      // Workflows whose checkpoint has taken a baseline on this connection.
      const baselined = new Set<string>();
      try {
        await consumeHermesStream({
          apiKey: this.apiKey,
          feedId,
          signal: subscription.controller.signal,
          onPrice: async (price) => {
            failures = 0;
            for (const registration of subscription.registrations) {
              if (subscription.controller.signal.aborted) {
                return;
              }
              const { workflowId } = registration;
              try {
                // Until the server records a baseline for this workflow on
                // this connection, the price must not be compared with the
                // one before the reconnect.
                const outcome = await submitPythObservation(
                  registration,
                  this.sessionId,
                  price,
                  !baselined.has(workflowId),
                );
                if (outcome === "baseline") {
                  baselined.add(workflowId);
                }
              } catch {
                // Do not let one workflow's dispatch failure drop other subscriptions.
                logger.warn(
                  `[Pyth] observation failed for ${workflowId}; pending signals remain recoverable`,
                );
              }
            }
          },
        });
      } catch {
        if (!subscription.controller.signal.aborted) {
          logger.warn(
            `[Pyth] feed ${feedId} disconnected or unavailable; reconnecting with a fresh baseline`,
          );
        }
      }
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      await abortableSleep(
        delay + Math.floor(Math.random() * 500),
        subscription.controller.signal,
      );
    }
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const subscription of this.subscriptions.values()) {
      subscription.controller.abort();
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(
          [...this.subscriptions.values()]
            .map((subscription) => subscription.task)
            .concat(this.pendingTask ?? Promise.resolve()),
        ),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 20_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    this.subscriptions.clear();
  }
}
