import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const keyDir = path.join(config.dataDir, "ssh");
const privPath = path.join(keyDir, "id_ed25519");
const pubPath = `${privPath}.pub`;

/**
 * The hub's control key. Its public half is installed into every remote's
 * authorized_keys by the install script; the private half never leaves here.
 */
export function ensureHubKey(): { publicKey: string; privateKeyPath: string } {
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(privPath)) {
    execFileSync("ssh-keygen", [
      "-t", "ed25519",
      "-N", "",
      "-C", "homedash-hub",
      "-f", privPath,
    ], { stdio: "pipe" });
    fs.chmodSync(privPath, 0o600);
  }
  return { publicKey: fs.readFileSync(pubPath, "utf8").trim(), privateKeyPath: privPath };
}

export function newId(bytes = 8): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Enrollment token: URL-safe, unambiguous, short enough to retype off a screen. */
export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}
