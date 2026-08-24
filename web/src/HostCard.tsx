import { useState } from "react";
import { api, type Host } from "./api";

/**
 * Enrollment and reachability are different facts. A machine that enrolled last
 * week and has been unplugged since is "joined" but not under control, and the
 * card has to say so plainly rather than showing stale specs as if they're live.
 */
function statusOf(host: Host): { label: string; tone: "ok" | "warn" | "bad" | "idle" } {
  if (host.status === "pending") return { label: "Waiting to join", tone: "warn" };
  if (host.status === "failed") return { label: "Install failed", tone: "bad" };
  if (host.reachable === null) return { label: "Checking…", tone: "idle" };
  return host.reachable
    ? { label: "Online", tone: "ok" }
    : { label: host.checkErrorKind === "host-key" ? "Key mismatch" : "Offline", tone: "bad" };
}

function gib(mb?: number) {
  return mb ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : "—";
}

function ago(ts: number | null) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function uptime(seconds?: number) {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

export function HostCard({
  host,
  onShowCommand,
  onRemove,
  onChecked,
}: {
  host: Host;
  onShowCommand: () => void;
  onRemove: () => void;
  onChecked: (host: Host) => void;
}) {
  const [checking, setChecking] = useState(false);
  const { label, tone } = statusOf(host);
  const f = host.facts;

  async function check() {
    setChecking(true);
    try {
      const { host: fresh } = await api.check(host.id);
      onChecked(fresh);
    } finally {
      setChecking(false);
    }
  }

  return (
    <article className={`card card-${tone}`}>
      <header className="card-head">
        <div>
          <h3>{host.name}</h3>
          <p className="muted small">{f?.hostname ?? host.address ?? "not yet reachable"}</p>
        </div>
        <span className={`pill pill-${tone}`}>{label}</span>
      </header>

      {host.status === "joined" && f ? (
        <>
          <dl className="specs">
            <div><dt>Address</dt><dd>{host.address}</dd></div>
            <div><dt>OS</dt><dd>{f.os ?? "—"}</dd></div>
            <div><dt>CPU</dt><dd>{f.cpu_cores ?? "?"} × {f.cpu_model ?? "unknown"}</dd></div>
            <div>
              <dt>Memory</dt>
              <dd>{f.mem_available_mb ? `${gib(f.mem_available_mb)} free of ` : ""}{gib(f.mem_mb)}</dd>
            </div>
            <div><dt>Disk</dt><dd>{f.disk_free_gb ?? "?"} GB free of {f.disk_gb ?? "?"} GB</dd></div>
            <div>
              <dt>Docker</dt>
              <dd>
                {f.docker ?? "—"}
                {f.containers_total !== undefined && (
                  <span className="muted"> · {f.containers_running}/{f.containers_total} running</span>
                )}
              </dd>
            </div>
            {f.uptime_s !== undefined && (
              <div><dt>Up</dt><dd>{uptime(f.uptime_s)}{f.load1 !== undefined && ` · load ${f.load1}`}</dd></div>
            )}
          </dl>

          {host.reachable === false && host.checkError && (
            <p className="card-note error">{host.checkError}</p>
          )}
        </>
      ) : host.status === "failed" ? (
        <p className="card-note error">{host.lastError}</p>
      ) : (
        <p className="card-note">Run the install command on this machine to finish connecting it.</p>
      )}

      <footer className="card-actions">
        {host.status === "joined" && (
          <span className="muted small check-stamp">
            {host.reachable === false ? `Last seen ${ago(host.lastSeen)}` : `Checked ${ago(host.lastCheckAt)}`}
          </span>
        )}
        {host.status === "joined" ? (
          <button className="btn btn-small" onClick={() => void check()} disabled={checking}>
            {checking ? "Checking…" : "Check now"}
          </button>
        ) : (
          <button className="btn btn-small" onClick={onShowCommand}>
            {host.enrollment ? "Show command" : "New code"}
          </button>
        )}
        <button className="btn btn-small btn-danger" onClick={onRemove}>Remove</button>
      </footer>
    </article>
  );
}
