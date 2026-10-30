# Deploying

## Docker

For a local run. The image is a three-stage build: Deno bundles the frontend, Go compiles the
server with that bundle embedded, and the result is copied into Alpine.

```sh
docker compose up --build
```

`go:embed` reads `src/backend/dist` at **compile** time, which is why the
frontend stage has to run first — see [development.md](development.md) for the
same trap when building by hand.

Environment, all optional:

| Variable             | Default                        | What it does                                    |
| -------------------- | ------------------------------ | ----------------------------------------------- |
| `STUN_URLS`          | `stun:stun.l.google.com:19302` | comma-separated STUN servers                    |
| `TURN_URLS`          | —                              | comma-separated TURN servers; enables TURN      |
| `TURN_SECRET`        | —                              | coturn's `static-auth-secret`                   |
| `TURN_TTL`           | `3600`                         | lifetime of an issued credential, seconds       |
| `MAX_ROOMS`          | `1000`                         | most rooms alive at once                        |
| `MAX_PEERS_PER_ROOM` | `100`                          | most peers (controller and viewers) in one room |
| `MAX_PEERS`          | `2000`                         | most signalling sockets across all rooms        |

A peer past a limit is closed with status 1013 and its client retries.

The server also takes `-addr` to move off `:8080` and `-dev` to read `dist/`
from disk instead of the embedded copy.

Two paths matter behind a proxy or a cache rule: **`/control`** is the
operator's page and **`/viewer`** is a display. `/` redirects to `/control`.
Everything else served from the root is a content-hashed asset.

## Who may frame this

`securityHeaders` in `src/backend/main.go` sends
`frame-ancestors 'self' https://17xande.dev`.

`'self'` is what lets the control page put `/viewer` in its own preview pane.
The named origin is the project's site, at `https://17xande.dev/teleprompter/`,
whose live demo frames `/control` and `/viewer?room=<id>` side by side so a
visitor drives the real app rather than watching a recording of it. Under `-dev`
the directive also admits `http://localhost:*` and `http://127.0.0.1:*`, so that
site can be developed against a local server; production never sees those.

If you self-host and want to embed this elsewhere, that is the line to edit, and
the only one. Framing grants nothing beyond display: a framed control page
reaches exactly the rooms any other control page does, and control of a room is
gated by the control key, not by who may frame the page.

A framing refusal is invisible from the server — it is reported in the _framing_
page's console — so a wrong origin here looks like a blank iframe and nothing
else.

## HTTPS

**Put TLS in front of this.** Two reasons, and the second is not obvious:

WebRTC in production needs HTTPS/WSS. And a handful of browser APIs are
restricted to a _secure origin_, which `http://` to anything but `localhost` is
not. The app is built to survive that — it mints its ids without
`crypto.randomUUID`, warns instead of throwing when the clipboard is missing,
and WebRTC data channels themselves need no secure context — so reaching it by
LAN address works. But it is one class of failure you simply do not have with
TLS, and the failure it used to produce was a page that looked like it was still
connecting.

If you serve it over plain HTTP on a LAN, that is a legitimate setup; just know
that "copy viewer link" falls back to logging the URL rather than reaching the
clipboard.

## Production: Kamal behind a Cloudflare Tunnel

This is what the project is actually deployed on: [Kamal](https://kamal-deploy.org)
(`config/deploy.yml`) to a Docker host at home (`home-docker`), with
**Cloudflare** in front for TLS and asset caching. The host runs kamal-proxy
with nothing published, behind one shared Cloudflare tunnel; that host-side
setup lives in `~/dev/17xande.dev/infra`. The tunnel's public hostname
`teleprompter.17xande.dev` has service `http://kamal-proxy:80`, and kamal-proxy
routes by host to the app (port 8080). Cloudflare terminates TLS, so Kamal runs
with `proxy.ssl: false`.

```sh
make deploy                        # tests, then kamal deploy (build, push to ghcr.io, swap in)
kamal rollback <version>           # back to an earlier image; `kamal app containers` lists them
make logs-prod                     # kamal app logs -f
```

`make deploy` refuses uncommitted tracked changes, since Kamal builds from
`HEAD`. Registry login is `gh auth token` (see `.kamal/secrets`). The app is
stateless (rooms live in memory), so there is no volume and a deploy drops every
open signalling socket; clients reconnect.

Things to get right:

- **WebSocket signalling passes through Cloudflare's proxy and kamal-proxy
  fine.** It needs no special treatment. The origin check in `signal.go`
  compares `Origin` with the request's `Host`, so do not set an `httpHostHeader`
  override on the tunnel hostname.
- **Cache rules should target the hashed `dist/` assets only, never `/ws`.** The
  bundle's filenames are content-hashed, so they are safe to cache hard; the
  signalling socket obviously is not.
- **The health check is `/viewer`**, a static page that returns 200. `/`
  redirects to `/control` and the app has no health route of its own.

Operating production, from this repo on your laptop
(untested beyond `make logs-prod`; reasoned from Kamal's behaviour):

```sh
kamal app logs -f            # or: kamal app logs --since 1h
kamal app details            # container state and version
```

The app has no secrets today and no env is set in `config/deploy.yml`, so the
defaults in the table above apply (public STUN, no TURN). Enabling TURN is
described in the next section.

## TURN (NAT/firewall fallback)

STUN gets peers connected in most co-located cases. TURN is the fallback for
networks that block direct peer traffic — guest wifi, client isolation.

The server sends the ICE config in the `welcome` message that opens every
signalling socket, so credentials are never hardcoded in the frontend and are
only issued to a peer that has joined a room (there is deliberately no HTTP
endpoint for them). The server issues short-lived HMAC credentials following
coturn's `use-auth-secret` scheme:

```sh
TURN_URLS="turn:turn.example.com:3478" \
TURN_SECRET="<same static-auth-secret as coturn>" \
TURN_TTL=3600 \
go run .
```

With no `TURN_URLS`/`TURN_SECRET` set, the welcome carries STUN only. Both are
needed: `TURN_SECRET` alone is ignored.

In the Kamal deploy, set `TURN_URLS` (and `STUN_URLS`/`TURN_TTL` if wanted)
under `env.clear` in `config/deploy.yml`, list `TURN_SECRET` under `env.secret`,
put its value in the gitignored `.env`, and add
`TURN_SECRET=$(sed -n 's/^TURN_SECRET=//p' .env | head -n 1)` to `.kamal/secrets`.
Kamal does not load `.env` itself, so a bare `TURN_SECRET=$TURN_SECRET` would read
your shell's environment, come out empty, and leave TURN silently off. Then
`make deploy`.

## Who can control a room

A room id alone does not grant control — the control key does, and it never
appears in a viewer link. See
[architecture.md](architecture.md#rooms-links-and-control). That is enough for a
trusted LAN or a private tunnel; exposed publicly, this wants real accounts,
which it does not have yet ([roadmap.md](roadmap.md)).
