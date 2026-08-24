import { db, logEvent, type HostRow } from "./db.js";
import { collectFacts, SshError } from "./ssh.js";

export type HealthResult =
  | { reachable: true; facts: Record<string, unknown> }
  | { reachable: false; error: string; kind: string };

/**
 * Proves we can still reach a host and refreshes its specs. This is the only
 * thing that distinguishes "enrolled once" from "actually under control".
 */
export async function checkHost(host: HostRow): Promise<HealthResult> {
  const now = Date.now();

  try {
    const facts = await collectFacts(host);
    db.prepare(
      `UPDATE hosts
          SET reachable = 1, last_seen = @now, last_check_at = @now,
              check_error = NULL, check_error_kind = NULL, facts = @facts
        WHERE id = @id`
    ).run({ id: host.id, now, facts: JSON.stringify(facts) });

    if (host.reachable === 0) {
      logEvent(host.id, "host.recovered", `${host.name} is reachable again`);
    }
    return { reachable: true, facts };
  } catch (err) {
    const kind = err instanceof SshError ? err.kind : "command";
    const message = (err as Error).message;

    db.prepare(
      `UPDATE hosts
          SET reachable = 0, last_check_at = @now, check_error = @error, check_error_kind = @kind
        WHERE id = @id`
    ).run({ id: host.id, now, error: message.slice(0, 2000), kind });

    // Log the transition, not every failed poll — a machine that is off for a
    // week should not bury everything else in the event list.
    if (host.reachable !== 0) {
      logEvent(host.id, "host.unreachable", `${host.name}: ${message}`, { kind });
    }
    return { reachable: false, error: message, kind };
  }
}

function joinedHosts(): HostRow[] {
  return db.prepare(`SELECT * FROM hosts WHERE status = 'joined'`).all() as HostRow[];
}

export async function checkAllHosts(): Promise<void> {
  // Sequential on purpose: a home lab is a handful of machines, and a stampede
  // of SSH connections is a worse failure mode than a slightly slower sweep.
  for (const host of joinedHosts()) {
    await checkHost(host).catch(() => undefined);
  }
}

/** Background sweep. Returns a stop function. */
export function startHeartbeat(intervalMs: number): () => void {
  let running = false;

  const tick = async () => {
    if (running) return; // A slow sweep must not overlap the next one.
    running = true;
    try {
      await checkAllHosts();
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
