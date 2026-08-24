import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { db, type HostRow } from "../db.js";
import { ensureHubKey } from "../keys.js";
import { checkHost } from "../health.js";
import {
  createPendingHost,
  deleteHost,
  getHost,
  listHosts,
  reissueToken,
} from "../enrollment.js";

/**
 * Where the remote should call us back. Explicit config wins; otherwise we echo
 * the address the browser reached us on, which is what makes the one-liner work
 * on a LAN with no DNS.
 */
export function hubUrlFor(req: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host;
  return `${proto}://${host}`;
}

function present(host: HostRow, req: FastifyRequest) {
  const tokenLive = !!host.token && !host.token_used_at && (host.token_expires ?? 0) > Date.now();
  return {
    id: host.id,
    name: host.name,
    status: host.status,
    address: host.address,
    sshUser: host.ssh_user,
    sshPort: host.ssh_port,
    hostKey: host.host_key,
    facts: host.facts ? JSON.parse(host.facts) : null,
    lastError: host.last_error,
    createdAt: host.created_at,
    joinedAt: host.joined_at,
    wantIp: host.want_ip,
    networkBackend: host.network_backend,
    reachable: host.reachable === null ? null : host.reachable === 1,
    lastSeen: host.last_seen,
    lastCheckAt: host.last_check_at,
    checkError: host.check_error,
    checkErrorKind: host.check_error_kind,
    enrollment: tokenLive
      ? {
          expiresAt: host.token_expires,
          command: `curl -fsSL ${hubUrlFor(req)}/i/${host.token} | sudo bash`,
        }
      : null,
  };
}

export async function hostRoutes(app: FastifyInstance) {
  app.get("/api/hub", async () => {
    const { publicKey } = ensureHubKey();
    return { publicKey };
  });

  app.get("/api/hosts", async (req) => ({
    hosts: listHosts().map((h) => present(h, req)),
  }));

  app.post("/api/hosts", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const name = (body.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "A name is required." });

    for (const [field, value] of [
      ["wantIp", body.wantIp],
      ["wantGateway", body.wantGateway],
      ["wantDns", body.wantDns],
    ] as const) {
      if (value && !/^[0-9a-fA-F:., ]+$/.test(value)) {
        return reply.code(400).send({ error: `${field} is not a valid address.` });
      }
    }

    const host = createPendingHost({
      name,
      wantIp: body.wantIp?.trim() || null,
      wantGateway: body.wantGateway?.trim() || null,
      wantDns: body.wantDns?.trim() || null,
    });
    return reply.code(201).send({ host: present(host, req) });
  });

  app.post("/api/hosts/:id/reissue", async (req, reply) => {
    const { id } = req.params as { id: string };
    const host = reissueToken(id);
    if (!host) return reply.code(404).send({ error: "No such host." });
    return { host: present(host, req) };
  });

  app.delete("/api/hosts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deleteHost(id)) return reply.code(404).send({ error: "No such host." });
    return reply.code(204).send();
  });

  app.get("/api/hosts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const host = getHost(id);
    if (!host) return reply.code(404).send({ error: "No such host." });
    return { host: present(host, req) };
  });

  /** Proves the SSH path still works and refreshes this host's specs. */
  app.post("/api/hosts/:id/check", async (req, reply) => {
    const { id } = req.params as { id: string };
    const host = getHost(id);
    if (!host) return reply.code(404).send({ error: "No such host." });
    if (host.status !== "joined") {
      return reply.code(409).send({ error: "This machine has not finished enrolling yet." });
    }

    const result = await checkHost(host);
    return { result, host: present(getHost(id)!, req) };
  });

  app.get("/api/hosts/:id/events", async (req) => {
    const { id } = req.params as { id: string };
    const rows = db
      .prepare(`SELECT kind, message, detail, at FROM events WHERE host_id = ? ORDER BY at DESC LIMIT 100`)
      .all(id) as Array<{ kind: string; message: string; detail: string | null; at: number }>;
    return {
      events: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })),
    };
  });
}
