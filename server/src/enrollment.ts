import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, logEvent, type HostRow } from "./db.js";
import { ensureHubKey, newId, newToken } from "./keys.js";

export type NewHostInput = {
  name: string;
  wantIp?: string | null;
  wantGateway?: string | null;
  wantDns?: string | null;
  sshUser?: string;
};

export function createPendingHost(input: NewHostInput): HostRow {
  const id = newId();
  const token = newToken();
  const now = Date.now();

  db.prepare(
    `INSERT INTO hosts (id, name, status, token, token_expires, want_ip, want_gateway, want_dns, ssh_user, created_at)
     VALUES (@id, @name, 'pending', @token, @expires, @wantIp, @wantGateway, @wantDns, @sshUser, @now)`
  ).run({
    id,
    name: input.name,
    token,
    expires: now + config.enrollTtlMs,
    wantIp: input.wantIp || null,
    wantGateway: input.wantGateway || null,
    wantDns: input.wantDns || null,
    sshUser: input.sshUser || "homedash",
    now,
  });

  logEvent(id, "enroll.created", `Enrollment code issued for "${input.name}"`);
  return getHost(id)!;
}

/** Mints a fresh token for a host whose code expired before anyone used it. */
export function reissueToken(id: string): HostRow | null {
  const host = getHost(id);
  if (!host) return null;
  const token = newToken();
  db.prepare(
    `UPDATE hosts SET token = ?, token_expires = ?, token_used_at = NULL, last_error = NULL WHERE id = ?`
  ).run(token, Date.now() + config.enrollTtlMs, id);
  logEvent(id, "enroll.reissued", "Enrollment code reissued");
  return getHost(id) ?? null;
}

export function getHost(id: string): HostRow | undefined {
  return db.prepare(`SELECT * FROM hosts WHERE id = ?`).get(id) as HostRow | undefined;
}

export function listHosts(): HostRow[] {
  return db.prepare(`SELECT * FROM hosts ORDER BY created_at DESC`).all() as HostRow[];
}

export function deleteHost(id: string): boolean {
  return db.prepare(`DELETE FROM hosts WHERE id = ?`).run(id).changes > 0;
}

export type TokenLookup =
  | { ok: true; host: HostRow }
  | { ok: false; reason: "unknown" | "expired" | "used" };

export function lookupToken(token: string): TokenLookup {
  const host = db.prepare(`SELECT * FROM hosts WHERE token = ?`).get(token) as HostRow | undefined;
  if (!host) return { ok: false, reason: "unknown" };
  if (host.token_used_at) return { ok: false, reason: "used" };
  if (host.token_expires && host.token_expires < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, host };
}

/**
 * Renders install.sh for one specific host. Everything the remote needs to
 * trust us, and everything we need to trust it, is decided here.
 */
export function renderInstallScript(host: HostRow, hubUrl: string): string {
  // Normalize line endings: a CRLF checkout on Windows would break the
  // shebang the moment this lands on a Debian box.
  const template = fs
    .readFileSync(path.join(config.scriptsDir, "install.sh"), "utf8")
    .replace(/\r\n/g, "\n");
  const { publicKey } = ensureHubKey();

  const substitutions: Record<string, string> = {
    "@@HUB_URL@@": hubUrl,
    "@@TOKEN@@": host.token ?? "",
    "@@HOST_ID@@": host.id,
    "@@SSH_USER@@": host.ssh_user,
    "@@HUB_PUBKEY@@": publicKey,
    "@@WANT_IP@@": host.want_ip ?? "",
    "@@WANT_GATEWAY@@": host.want_gateway ?? "",
    "@@WANT_DNS@@": host.want_dns ?? "",
  };

  let out = template;
  for (const [needle, value] of Object.entries(substitutions)) {
    if (/["`$\\\n]/.test(value)) {
      throw new Error(`Refusing to render install script: unsafe value for ${needle}`);
    }
    out = out.split(needle).join(value);
  }
  return out;
}

export type EnrollReport = {
  host_id: string;
  ssh_user: string;
  ssh_port: number;
  host_key: string;
  address: string;
  address_pending?: number;
  facts: Record<string, unknown>;
};

/**
 * Completes enrollment: burns the token and pins the remote's host key, so
 * every later SSH connection is verified against the machine we actually saw.
 */
export function completeEnrollment(host: HostRow, report: EnrollReport): HostRow {
  const now = Date.now();
  db.prepare(
    `UPDATE hosts
        SET status = 'joined', token_used_at = @now, joined_at = @now, last_error = NULL,
            address = @address, ssh_user = @sshUser, ssh_port = @sshPort,
            host_key = @hostKey, facts = @facts
      WHERE id = @id`
  ).run({
    id: host.id,
    now,
    address: report.address,
    sshUser: report.ssh_user || host.ssh_user,
    sshPort: report.ssh_port || 22,
    hostKey: report.host_key,
    facts: JSON.stringify(report.facts ?? {}),
  });

  pinHostKey(report.address, report.ssh_port || 22, report.host_key);
  logEvent(host.id, "enroll.joined", `${report.facts?.hostname ?? report.address} joined`, report.facts);
  return getHost(host.id)!;
}

export function failEnrollment(host: HostRow, error: string) {
  db.prepare(`UPDATE hosts SET status = 'failed', last_error = ? WHERE id = ?`).run(error, host.id);
  logEvent(host.id, "enroll.failed", error);
}

/** Rewrites our known_hosts so a re-enrolled machine replaces its old entry. */
function pinHostKey(address: string, port: number, hostKey: string) {
  const knownHosts = path.join(config.dataDir, "ssh", "known_hosts");
  fs.mkdirSync(path.dirname(knownHosts), { recursive: true });
  const label = port === 22 ? address : `[${address}]:${port}`;
  const existing = fs.existsSync(knownHosts) ? fs.readFileSync(knownHosts, "utf8").split("\n") : [];
  const kept = existing.filter((line) => line.trim() && !line.startsWith(`${label} `));
  kept.push(`${label} ${hostKey}`);
  fs.writeFileSync(knownHosts, kept.join("\n") + "\n", { mode: 0o600 });
}
