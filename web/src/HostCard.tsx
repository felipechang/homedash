import type { Host } from "./api";

const STATUS_LABEL = {
  pending: "Waiting to join",
  joined: "Connected",
  failed: "Install failed",
} as const;

function gib(mb?: number) {
  return mb ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : "—";
}

export function HostCard({
  host,
  onShowCommand,
  onRemove,
}: {
  host: Host;
  onShowCommand: () => void;
  onRemove: () => void;
}) {
  const f = host.facts;
  return (
    <article className={`card card-${host.status}`}>
      <header className="card-head">
        <div>
          <h3>{host.name}</h3>
          <p className="muted small">{f?.hostname ?? host.address ?? "not yet reachable"}</p>
        </div>
        <span className={`pill pill-${host.status}`}>{STATUS_LABEL[host.status]}</span>
      </header>

      {host.status === "joined" && f ? (
        <dl className="specs">
          <div><dt>Address</dt><dd>{host.address}</dd></div>
          <div><dt>OS</dt><dd>{f.os ?? "—"}</dd></div>
          <div><dt>CPU</dt><dd>{f.cpu_cores ?? "?"} × {f.cpu_model ?? "unknown"}</dd></div>
          <div><dt>Memory</dt><dd>{gib(f.mem_mb)}</dd></div>
          <div><dt>Disk</dt><dd>{f.disk_free_gb ?? "?"} GB free of {f.disk_gb ?? "?"} GB</dd></div>
          <div><dt>Docker</dt><dd>{f.docker ?? "—"}</dd></div>
        </dl>
      ) : host.status === "failed" ? (
        <p className="card-note error">{host.lastError}</p>
      ) : (
        <p className="card-note">
          Run the install command on this machine to finish connecting it.
        </p>
      )}

      <footer className="card-actions">
        {host.status !== "joined" && (
          <button className="btn btn-small" onClick={onShowCommand}>
            {host.enrollment ? "Show command" : "New code"}
          </button>
        )}
        <button className="btn btn-small btn-danger" onClick={onRemove}>Remove</button>
      </footer>
    </article>
  );
}
