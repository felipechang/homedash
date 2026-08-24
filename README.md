# homedash

A control panel for a home lab, aimed at people who have a spare Debian box and
no appetite for a weekend of `ssh` and YAML.

The hub is one web app that does two jobs: it serves the control panel, and it
serves the install script that joins a machine to it. Adding a remote means
clicking **New remote** and pasting one line into that machine's terminal.

## Status

Enrollment works end to end. The remaining tabs (Apps, Storage, Logs, Policies,
Chat) are stubs.

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
  scripts/
    install.sh       the script remotes run
web/
  src/               React control panel
```

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
