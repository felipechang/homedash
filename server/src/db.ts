import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, "homedash.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS hosts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | joined | failed
  -- enrollment
  token         TEXT UNIQUE,
  token_expires INTEGER,
  token_used_at INTEGER,
  -- desired network (null => script pins whatever the box currently holds)
  want_ip       TEXT,
  want_gateway  TEXT,
  want_dns      TEXT,
  -- learned at join time
  address       TEXT,
  ssh_user      TEXT NOT NULL DEFAULT 'homedash',
  ssh_port      INTEGER NOT NULL DEFAULT 22,
  host_key      TEXT,          -- remote's SSH host public key, pinned on join
  facts         TEXT,          -- JSON blob of machine specs
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  joined_at     INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id   TEXT REFERENCES hosts(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  message   TEXT NOT NULL,
  detail    TEXT,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_host_at ON events(host_id, at DESC);
`);

export type HostRow = {
  id: string;
  name: string;
  status: "pending" | "joined" | "failed";
  token: string | null;
  token_expires: number | null;
  token_used_at: number | null;
  want_ip: string | null;
  want_gateway: string | null;
  want_dns: string | null;
  address: string | null;
  ssh_user: string;
  ssh_port: number;
  host_key: string | null;
  facts: string | null;
  last_error: string | null;
  created_at: number;
  joined_at: number | null;
};

export function logEvent(hostId: string | null, kind: string, message: string, detail?: unknown) {
  db.prepare(
    `INSERT INTO events (host_id, kind, message, detail, at) VALUES (?, ?, ?, ?, ?)`
  ).run(hostId, kind, message, detail === undefined ? null : JSON.stringify(detail), Date.now());
}
