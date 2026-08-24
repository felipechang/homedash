import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";
import { readScript } from "./enrollment.js";
import { ensureHubKey } from "./keys.js";
import type { HostRow } from "./db.js";

export type SshTarget = Pick<HostRow, "address" | "ssh_user" | "ssh_port">;

export class SshError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "host-key" | "auth" | "command" | "timeout",
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
    this.name = "SshError";
  }
}

/** Single-quotes a value for safe interpolation into a remote shell command. */
export function shq(value: string | number): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Tagged template that quotes every interpolated value:
 *
 *   sh`docker compose -f ${file} up -d`
 *
 * The remote runs our string through its own shell, so anything we splice in
 * has to be quoted here. Never build remote commands by concatenation.
 */
export function sh(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  return strings.reduce((out, part, i) => out + part + (i < values.length ? shq(values[i]) : ""), "");
}

function knownHostsPath() {
  return path.join(config.dataDir, "ssh", "known_hosts");
}

function baseArgs(target: SshTarget): string[] {
  const { privateKeyPath } = ensureHubKey();
  return [
    "-i", privateKeyPath,
    "-o", `UserKnownHostsFile=${knownHostsPath()}`,
    // The remote's host key was pinned at enrollment. Refuse anything else:
    // a mismatch means we are not talking to the machine we enrolled.
    "-o", "StrictHostKeyChecking=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
    "-p", String(target.ssh_port || 22),
    `${target.ssh_user}@${target.address}`,
  ];
}

/** Turns ssh's stderr into something a control panel can act on. */
function classify(stderr: string, code: number | null): SshError | null {
  const s = stderr.toLowerCase();
  if (s.includes("host key verification failed") || s.includes("remote host identification has changed")) {
    return new SshError(
      "This machine is presenting a different SSH host key than the one recorded at enrollment. It may have been rebuilt, or something is impersonating it.",
      "host-key",
      code,
      stderr
    );
  }
  if (s.includes("permission denied") || s.includes("too many authentication failures")) {
    return new SshError("The control panel's SSH key was rejected by this machine.", "auth", code, stderr);
  }
  if (
    s.includes("connection refused") ||
    s.includes("connection timed out") ||
    s.includes("no route to host") ||
    s.includes("could not resolve hostname") ||
    s.includes("network is unreachable") ||
    s.includes("operation timed out")
  ) {
    return new SshError("This machine is not reachable.", "unreachable", code, stderr);
  }
  return null;
}

export type RunOptions = {
  /** Prefix with `sudo -n`. The homedash account has passwordless sudo. */
  sudo?: boolean;
  stdin?: string;
  timeoutMs?: number;
  /** Return the result instead of throwing when the command exits non-zero. */
  allowFailure?: boolean;
};

export type RunResult = { stdout: string; stderr: string; code: number };

/** Runs one command on a remote and waits for it to finish. */
export function run(target: SshTarget, command: string, opts: RunOptions = {}): Promise<RunResult> {
  if (!target.address) {
    return Promise.reject(new SshError("This host has no known address.", "unreachable", null, ""));
  }
  const remote = opts.sudo ? `sudo -n ${command}` : command;

  return new Promise((resolve, reject) => {
    const child = execFile(
      "ssh",
      [...baseArgs(target), "--", remote],
      { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;

        if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          return reject(new SshError("The command timed out.", "timeout", null, stderr));
        }
        const transport = classify(stderr, code);
        if (transport) return reject(transport);

        if (code !== 0 && !opts.allowFailure) {
          return reject(
            new SshError(
              stderr.trim().split("\n").slice(-1)[0] || `Command failed with exit code ${code}.`,
              "command",
              code,
              stderr
            )
          );
        }
        resolve({ stdout, stderr, code });
      }
    );

    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });
}

/**
 * Pipes a local script to the remote's shell. Nothing is left behind on the
 * remote, and the hub's copy is always the version that runs.
 */
export async function runScript(
  target: SshTarget,
  scriptName: string,
  opts: Omit<RunOptions, "stdin"> = {}
): Promise<RunResult> {
  return run(target, "bash -s", { ...opts, stdin: readScript(scriptName) });
}

/** Long-running command with live output, for log tailing. */
export function stream(target: SshTarget, command: string, opts: { sudo?: boolean } = {}) {
  const remote = opts.sudo ? `sudo -n ${command}` : command;
  return spawn("ssh", [...baseArgs(target), "--", remote], { stdio: ["ignore", "pipe", "pipe"] });
}

export type HostFacts = Record<string, unknown>;

/** Re-reads a joined host's specs over SSH using the same collector enrollment used. */
export async function collectFacts(target: SshTarget): Promise<HostFacts> {
  const { stdout } = await runScript(target, "facts.sh", { timeoutMs: 20_000 });
  try {
    return JSON.parse(stdout) as HostFacts;
  } catch {
    throw new SshError("The machine returned specs we could not read.", "command", 0, stdout.slice(0, 500));
  }
}
