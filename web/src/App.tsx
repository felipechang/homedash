import { useCallback, useEffect, useState } from "react";
import { api, type Host } from "./api";
import { EnrollDialog } from "./EnrollDialog";
import { HostCard } from "./HostCard";

const TABS = ["Remotes", "Apps", "Storage", "Logs", "Policies", "Chat"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>("Remotes");
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<Host | null>(null);

  const refresh = useCallback(async () => {
    try {
      setHosts(await api.listHosts());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A machine can join at any moment during enrollment, so poll while we wait.
  useEffect(() => {
    const waiting = hosts?.some((h) => h.status === "pending" || h.reachable === null);
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [hosts, refresh]);

  // Keep the open dialog in step with what the server now knows.
  useEffect(() => {
    if (!enrolling || !hosts) return;
    const fresh = hosts.find((h) => h.id === enrolling.id);
    if (fresh && fresh !== enrolling) setEnrolling(fresh);
  }, [hosts, enrolling]);

  async function addRemote(input: { name: string; wantIp?: string; wantGateway?: string; wantDns?: string }) {
    const host = await api.createHost(input);
    setEnrolling(host);
    await refresh();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          homedash
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={t === tab ? "tab tab-active" : "tab"}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {tab === "Remotes" ? (
          <section>
            <div className="section-head">
              <div>
                <h1>Remotes</h1>
                <p className="muted">Machines this control panel manages over SSH.</p>
              </div>
              <button className="btn btn-primary" onClick={() => setEnrolling({ id: "", name: "" } as Host)}>
                New remote
              </button>
            </div>

            {error && <div className="banner banner-error">{error}</div>}

            {hosts === null ? (
              <p className="muted">Loading…</p>
            ) : hosts.length === 0 ? (
              <div className="empty">
                <h2>No machines yet</h2>
                <p className="muted">
                  Add your first Debian box. You will get a single command to paste into its terminal —
                  it sets up the login, pins the address, installs Docker, and reports back here.
                </p>
              </div>
            ) : (
              <div className="host-grid">
                {hosts.map((h) => (
                  <HostCard
                    key={h.id}
                    host={h}
                    onShowCommand={() => setEnrolling(h)}
                    onRemove={async () => {
                      await api.removeHost(h.id);
                      await refresh();
                    }}
                    onChecked={(fresh) =>
                      setHosts((prev) => prev?.map((x) => (x.id === fresh.id ? fresh : x)) ?? prev)
                    }
                  />
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="empty">
            <h2>{tab}</h2>
            <p className="muted">Not built yet — enrollment lands first.</p>
          </section>
        )}
      </main>

      {enrolling && (
        <EnrollDialog
          host={enrolling.id ? enrolling : null}
          onCreate={addRemote}
          onReissue={async (id) => setEnrolling(await api.reissue(id))}
          onClose={() => {
            setEnrolling(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
