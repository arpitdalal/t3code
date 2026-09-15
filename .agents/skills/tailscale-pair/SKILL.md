---
name: tailscale-pair
description: Mint a Tailscale MagicDNS pairing URL for a phone or remote client against a running T3 Code environment. Use when pairing iOS/Android over Tailscale, repairing a 502 Tailscale Serve mapping for Vite-dev, or minting a fresh one-time pairing token for an already-running local stack.
---

# Tailscale pair

Hand the user one unused MagicDNS pairing URL. Never open or exchange the token yourself.

User-facing background: [remote access — Tailscale HTTPS](../../../docs/user/remote-access.md#tailscale-https).

## Preconditions

1. Confirm `tailscale status` shows this machine Connected and lists the phone (or other client) on the same tailnet.
2. Confirm a T3 server is running. Done when `server-runtime.json` for that home has a live `pid` and `curl -sf <origin>/.well-known/t3/environment` returns 200.

## Discover the live home

Search, in order, until one runtime state file has a live pid and a reachable origin:

1. Worktree `.t3` under the repo root (if inside a linked worktree).
2. `$T3CODE_HOME` when set.
3. `~/.t3`.

For each base, check `userdata/server-runtime.json` and `dev/server-runtime.json`.

Record `baseDir`, `port` (server), `origin`, and `devUrl` when present. Pass that `baseDir` to every `pair` invocation so the token lands in the DB the live server reads.

## Choose the publish branch

### Production / headless server (no `devUrl`)

```bash
node apps/server/src/bin.ts pair --base-dir <baseDir> --ttl <ttl> --tailscale
```

Default `<ttl>` to `24h` unless the user asked for something else. Done when the command prints a `https://…ts.net/…/pair#token=…` URL and `curl -sf https://<magicdns>/.well-known/t3/environment` returns 200.

### Vite-dev (`devUrl` set — typical `vp run dev`)

`pair --tailscale` proxies to `127.0.0.1`, but Vite often binds only `::1`, so Serve 502s. Publish with a `localhost` target instead (same fix as `vp run dev --share`):

```bash
WEB_PORT=<port from devUrl>   # e.g. 5733
tailscale serve --https=443 off 2>/dev/null || true
tailscale serve --bg --https=443 "http://localhost:${WEB_PORT}"
```

Done when `tailscale serve status` shows `http://localhost:<WEB_PORT>` and the MagicDNS descriptor check below returns 200.

Then mint **without** `--tailscale`:

```bash
node apps/server/src/bin.ts pair --base-dir <baseDir> --ttl <ttl>
```

Build the handoff URL from MagicDNS + the printed token (ignore the localhost pairing URL):

`https://<magicDnsName>/pair#token=<token>`

Resolve `<magicDnsName>` from `tailscale status --json` → `Self.DNSName` (strip a trailing dot).

### Fresh stack the user is willing to restart

```bash
vp run dev --share
```

Hand them the printed `pairingUrl:` (token included). Skip the repair steps above.

## Verify without consuming

```bash
curl -sf --max-time 8 "https://<magicDnsName>/.well-known/t3/environment"
```

Must be HTTP 200. Do not POST `/oauth/token` and do not open the `/pair#token=…` URL — both consume the one-time credential.

## Handoff

Reply with only:

1. The full `https://…/pair#token=…` URL.
2. The expiry time from the mint output.
3. One line: paste into the mobile app under **Settings → Environments → Add environment** (or scan the QR if they are at the terminal).

If Serve was remapped for Vite-dev, note that another `pair --tailscale` will break the mapping again until Vite binds IPv4 or the stack is restarted with `--share`.
