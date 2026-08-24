import { useEffect, useState } from "react";
import type { Host } from "./api";

type Props = {
  /** null while we are still collecting details for a brand-new remote. */
  host: Host | null;
  onCreate: (input: { name: string; wantIp?: string; wantGateway?: string; wantDns?: string }) => Promise<void>;
  onReissue: (id: string) => Promise<void>;
  onClose: () => void;
};

export function EnrollDialog({ host, onCreate, onReissue, onClose }: Props) {
  const [name, setName] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [wantIp, setWantIp] = useState("");
  const [wantGateway, setWantGateway] = useState("");
  const [wantDns, setWantDns] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        wantIp: wantIp.trim() || undefined,
        wantGateway: wantGateway.trim() || undefined,
        wantDns: wantDns.trim() || undefined,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        {!host ? (
          <form onSubmit={submit}>
            <h2>Add a remote</h2>
            <p className="muted">
              Give the machine a name. Everything else is detected on the box itself.
            </p>

            <label className="field">
              <span>Name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="media-server"
                required
              />
            </label>

            <button type="button" className="linkish" onClick={() => setAdvanced(!advanced)}>
              {advanced ? "Hide" : "Set a specific IP address"}
            </button>

            {advanced && (
              <div className="advanced">
                <p className="muted small">
                  Leave blank and the machine keeps the address it already has — the install just
                  makes it permanent. Fill these in only to move it somewhere specific.
                </p>
                <label className="field">
                  <span>Static IP</span>
                  <input value={wantIp} onChange={(e) => setWantIp(e.target.value)} placeholder="192.168.1.50" />
                </label>
                <label className="field">
                  <span>Gateway</span>
                  <input value={wantGateway} onChange={(e) => setWantGateway(e.target.value)} placeholder="192.168.1.1" />
                </label>
                <label className="field">
                  <span>DNS</span>
                  <input value={wantDns} onChange={(e) => setWantDns(e.target.value)} placeholder="1.1.1.1, 9.9.9.9" />
                </label>
              </div>
            )}

            {error && <div className="banner banner-error">{error}</div>}

            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
                {busy ? "Creating…" : "Get install command"}
              </button>
            </div>
          </form>
        ) : host.status === "joined" ? (
          <div>
            <h2>{host.name} is connected</h2>
            <p className="muted">
              {host.facts?.hostname} at {host.address} — Docker {host.facts?.docker ? "ready" : "missing"}.
            </p>
            <div className="dialog-actions">
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <div>
            <h2>Run this on {host.name}</h2>
            <p className="muted">
              Paste it into a root terminal on the machine. It creates the control account, pins the
              address, installs Docker, then reports back here.
            </p>

            {host.enrollment ? (
              <>
                <pre className="command">{host.enrollment.command}</pre>
                <div className="dialog-actions dialog-actions-split">
                  <span className="muted small">
                    Code expires {new Date(host.enrollment.expiresAt).toLocaleTimeString()}
                  </span>
                  <div>
                    <button className="btn" onClick={() => copy(host.enrollment!.command)}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <button className="btn btn-primary" onClick={onClose}>Close</button>
                  </div>
                </div>
                <p className="waiting">
                  <span className="pulse" aria-hidden="true" /> Waiting for {host.name} to check in…
                </p>
              </>
            ) : (
              <>
                <div className="banner banner-error">
                  {host.lastError ?? "This code is no longer valid."}
                </div>
                <div className="dialog-actions">
                  <button className="btn" onClick={onClose}>Close</button>
                  <button className="btn btn-primary" onClick={() => void onReissue(host.id)}>
                    Issue a new code
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
