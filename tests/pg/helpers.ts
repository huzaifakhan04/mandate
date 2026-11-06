import { sql } from "drizzle-orm";

import type { Db } from "@/server/db/client";

export { call, createSimWorld, createTestAgent, type Data, fundPool } from "../helpers/world";

export interface Gate {
  promise: Promise<void>;
  open: () => void;
}

export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Opens a transaction on its own pool connection that runs `lockSql`
 * (e.g. `SELECT … FOR UPDATE`) and then holds it until `release()` — so
 * the calls under test pile up behind the same row lock and are released
 * together, i.e. they genuinely overlap instead of running back to back.
 */
export async function holdLock(db: Db, lockSql: ReturnType<typeof sql>) {
  const locked = gate();
  const released = gate();
  const done = db.transaction(async (tx) => {
    await tx.execute(lockSql);
    locked.open();
    await released.promise;
  });
  await locked.promise;
  return {
    release: async () => {
      released.open();
      await done;
    },
  };
}

/** Number of backends in this database currently blocked on a heavyweight lock. */
export async function lockWaiters(db: Db): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return (result.rows[0] as { n: number }).n;
}

/** Polls until at least `n` backends wait on a lock (or fails after `timeoutMs`). */
export async function waitForLockWaiters(db: Db, n: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiting = await lockWaiters(db);
    if (waiting >= n) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`expected ${n} lock waiters, saw ${waiting}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
