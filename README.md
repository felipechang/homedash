# homedash

A control panel for a home lab, aimed at people who have a spare Debian box and
no appetite for a weekend of `ssh` and YAML.

The hub is one web app that does two jobs: it serves the control panel, and it
serves the install script that joins a machine to it. Adding a remote means
clicking **New remote** and pasting one line into that machine's terminal.

## Status

Enrollment and the SSH control path work end to end. The remaining tabs (Apps,
Storage, Logs, Policies, Chat) are stubs.

## Running it

```bash
npm install
npm run build
npm start
```

The panel and the enrollment endpoint share one origin on port 8080, so there is
exactly one address to remember. For development, `npm run dev` runs the API on
8080 and the panel on 5173 with a proxy in front.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOMEDASH_PORT` | `8080` | Listen port |
| `HOMEDASH_DATA` | `./data` | SQLite DB, hub SSH key, pinned `known_hosts` |
| `HOMEDASH_PUBLIC_URL` | derived from the request | Override the callback URL remotes are told to use |
| `HOMEDASH_ENROLL_TTL_MS` | 30 min | How long an enrollment code stays valid |
| `HOMEDASH_HEARTBEAT_MS` | 60 s | How often joined hosts are polled over SSH (`0` disables) |

## How enrollment works

1. **New remote** creates a pending host with a single-use code that expires in
   30 minutes, and shows `curl -fsSL http://hub:8080/i/<code> | sudo bash`.
2. `GET /i/<code>` renders [install.sh](server/scripts/install.sh) for that one
   host, with the hub's **public** key and that host's callback token baked in.
3. On the remote, the script creates a `homedash` account with passwordless
   sudo, authorizes the hub's key for it, pins the IP address, installs Docker,
   and collects the machine's specs.
4. The script POSTs those specs back along with the machine's **SSH host key**.
   The hub burns the code and writes that key into its own `known_hosts`.

Both directions of trust are established inside the one window the code is
valid: the remote learns which key may log in, and the hub learns which host key
to expect. Every later SSH connection is verified against the machine we
actually saw.

### About the IP address

By default the script keeps the address the machine already has and simply makes
it permanent — nothing about connectivity changes, so a novice cannot lock
themselves out. If a specific IP is requested in the dialog, the script applies
it only *after* reporting back, and warns first, because the SSH session running
the script will drop.

`systemd-networkd` and `ifupdown` are both supported; the script detects which
one the machine actually uses.

## Staying in control

Enrolling proves a machine could reach the hub. It does not prove the hub can
reach the machine, and those come apart the moment a box is unplugged or
rebuilt. So a joined host starts with its reachability *unknown*, and a
heartbeat sweep settles it by actually opening an SSH connection and re-reading
the specs. The card says Online, Offline, or Key mismatch based on that, never
on "it enrolled once."

Every remote command goes through [ssh.ts](server/src/ssh.ts):

- `run(host, command)` — one command, with `sudo` and stdin options
- `runScript(host, name)` — pipes a script from `server/scripts/` to the remote
  shell, so the hub's copy is always the version that runs
- `stream(host, command)` — live output, for log tailing
- `sh` / `shq` — a tagged template that single-quotes every interpolated value

Build remote commands with the `` sh`...` `` template, never by concatenation:

```ts
await run(host, sh`docker compose -f ${composePath} up -d`, { sudo: true });
```

Connections use `StrictHostKeyChecking=yes` against the `known_hosts` written at
enrollment. A machine presenting a different host key is refused and surfaced as
a key mismatch rather than quietly trusted — that is the case where a box was
rebuilt, or something is sitting where it used to be.

`facts.sh` is the single source of truth for the fact schema: `install.sh`
downloads it at enrollment, and the heartbeat pipes the same file over SSH.

## Layout

```
server/
  src/
    config.ts        environment and paths
    db.ts            SQLite schema (node:sqlite, no native deps)
    keys.ts          the hub's ed25519 control key
    enrollment.ts    token lifecycle, script rendering, host-key pinning
    routes/
      hosts.ts       control panel API
      enroll.ts      /i/<code> and the facts callback
    ssh.ts           the SSH executor every remote action goes through
    health.ts        reachability checks and the heartbeat sweep
  scripts/
    install.sh       the script remotes run at enrollment
    facts.sh         machine specs, used by both enrollment and heartbeats
web/
  src/               React control panel
```

## Developing on Windows

The hub is meant to run on Linux. Windows works for the panel and enrollment,
but OpenSSH on Windows enforces private-key file permissions through ACLs that
`chmod` does not set, so outbound SSH to a real remote may be refused there. Run
the hub on the Debian box (or in WSL) to exercise the SSH path.

## Design notes

**The hub holds the only private key.** It is generated on first start into
`data/ssh/` and never leaves. The install script only ever carries the public
half.

**Policy is enforced at the tool boundary, not in the prompt.** When the chat tab
lands, the agent will not get a raw shell — it gets typed tools (`run_on_host`,
`deploy_stack`, `create_mount`, `read_logs`), and every call passes through a
policy engine that can deny before anything reaches SSH. "Never disable ufw"
has to be a gate in code; a model instructed not to do something is not a
control.
