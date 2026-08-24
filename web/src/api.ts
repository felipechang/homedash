export type Facts = {
  hostname?: string;
  os?: string;
  kernel?: string;
  arch?: string;
  virt?: string;
  cpu_model?: string;
  cpu_cores?: number;
  mem_mb?: number;
  disk_gb?: number;
  disk_free_gb?: number;
  iface?: string;
  mac?: string;
  docker?: string;
  compose?: string;
  load1?: number;
  mem_available_mb?: number;
  uptime_s?: number;
  containers_running?: number;
  containers_total?: number;
};

export type Host = {
  id: string;
  name: string;
  status: "pending" | "joined" | "failed";
  address: string | null;
  sshUser: string;
  sshPort: number;
  hostKey: string | null;
  facts: Facts | null;
  lastError: string | null;
  createdAt: number;
  joinedAt: number | null;
  wantIp: string | null;
  networkBackend: string | null;
  /** null until the hub has actually tried to SSH in. */
  reachable: boolean | null;
  lastSeen: number | null;
  lastCheckAt: number | null;
  checkError: string | null;
  checkErrorKind: string | null;
  enrollment: { expiresAt: number; command: string } | null;
};

export type CheckResult =
  | { reachable: true; facts: Facts }
  | { reachable: false; error: string; kind: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(detail.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  listHosts: () => request<{ hosts: Host[] }>("/api/hosts").then((r) => r.hosts),

  createHost: (input: { name: string; wantIp?: string; wantGateway?: string; wantDns?: string }) =>
    request<{ host: Host }>("/api/hosts", { method: "POST", body: JSON.stringify(input) }).then((r) => r.host),

  reissue: (id: string) =>
    request<{ host: Host }>(`/api/hosts/${id}/reissue`, { method: "POST" }).then((r) => r.host),

  removeHost: (id: string) => request<void>(`/api/hosts/${id}`, { method: "DELETE" }),

  check: (id: string) =>
    request<{ result: CheckResult; host: Host }>(`/api/hosts/${id}/check`, { method: "POST" }),
};
