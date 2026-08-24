import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, so data/ and scripts/ resolve the same in dev (tsx) and prod (dist). */
export const serverRoot = path.resolve(here, "..");

export const config = {
  port: Number(process.env.HOMEDASH_PORT ?? 8080),
  host: process.env.HOMEDASH_BIND ?? "0.0.0.0",
  dataDir: process.env.HOMEDASH_DATA ?? path.join(serverRoot, "..", "data"),
  scriptsDir: path.join(serverRoot, "scripts"),
  webDist: path.join(serverRoot, "..", "web", "dist"),
  /**
   * Base URL remotes use to reach the hub. Left unset, each request derives it
   * from its own Host header, which is what makes the copy-paste one-liner work
   * on a LAN with no DNS.
   */
  publicUrl: process.env.HOMEDASH_PUBLIC_URL ?? null,
  /** Enrollment tokens are single-use and short-lived. */
  enrollTtlMs: Number(process.env.HOMEDASH_ENROLL_TTL_MS ?? 30 * 60 * 1000),
};
