const baseUrl = (process.env.HOMEDASH_URL ?? "http://localhost:8080").replace(/\/+$/, "");

export class HomedashApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "HomedashApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new HomedashApiError(
      typeof data.error === "string" ? data.error : `Request failed with status ${res.status}.`,
      res.status
    );
  }
  return data as T;
}

export type ApiHost = {
  id: string;
  name: string;
  status: "pending" | "joined" | "failed";
  address: string | null;
  sshUser: string;
  sshPort: number;
  hostKey: string | null;
  facts: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: number;
  joinedAt: number | null;
  wantIp: string | null;
  networkBackend: string | null;
  reachable: boolean | null;
  lastSeen: number | null;
  lastCheckAt: number | null;
  checkError: string | null;
  checkErrorKind: string | null;
  enrollment: { expiresAt: number; command: string } | null;
};

export type ApiEvent = {
  kind: string;
  message: string;
  detail: unknown;
  at: number;
};

export type HealthResult =
  | { reachable: true; facts: Record<string, unknown> }
  | { reachable: false; error: string; kind: string };

export const homedash = {
  getHubKey: () => request<{ publicKey: string }>("GET", "/api/hub"),

  listHosts: () => request<{ hosts: ApiHost[] }>("GET", "/api/hosts"),

  getHost: (id: string) => request<{ host: ApiHost }>("GET", `/api/hosts/${encodeURIComponent(id)}`),

  createHost: (input: { name: string; wantIp?: string; wantGateway?: string; wantDns?: string }) =>
    request<{ host: ApiHost }>("POST", "/api/hosts", input),

  reissueToken: (id: string) => request<{ host: ApiHost }>("POST", `/api/hosts/${encodeURIComponent(id)}/reissue`),

  deleteHost: (id: string) => request<void>("DELETE", `/api/hosts/${encodeURIComponent(id)}`),

  checkHost: (id: string) =>
    request<{ result: HealthResult; host: ApiHost }>("POST", `/api/hosts/${encodeURIComponent(id)}/check`),

  getHostEvents: (id: string) => request<{ events: ApiEvent[] }>("GET", `/api/hosts/${encodeURIComponent(id)}/events`),
};
