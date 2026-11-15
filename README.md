# agent-lens

Lets a coding agent see what it built. One command line tool, two independent modules:

- **`agent-lens mc`** drives a real Minecraft client (Fabric plus the bundled `lens` mod) over a loopback HTTP API:
  join a world or a test server, run commands, open screens, and capture cropped screenshots of inventories,
  tooltips, dialogs, chat, HUD parts and particles. It also records the game's sound (WAV, waveform picture, list
  of the sounds played with their timing, optionally a video). Scenes replay the same steps against two builds.
- **`agent-lens web`** takes browser screenshots of pages and page sections (Chromium, WebKit, Firefox), measures
  elements, prints an ARIA snapshot with console errors for a quick check, and builds before/after composites.

`agent-lens pr` puts the resulting images into a pull request (OneDev, GitHub, Forgejo/Gitea).

Every command is one shot: compact text out (JSON with `--json`), non-zero exit with the reason on stderr.
Nothing runs while idle. There is no daemon: the Minecraft client starts on the first `mc` command and exits by
itself after ten idle minutes; a web command is one `docker run --rm`.

## Requirements

- Linux.
- Node.js 22 or newer (`node` on PATH, or [mise](https://mise.jdx.dev), which the wrapper then uses).
- For `mc`: a JDK 25, and a GPU render node (`/dev/dri/renderD*`) or software GL (Mesa llvmpipe). No display
  server is needed. About 1.5 GB of memory while the client runs, about 1 GB of disk for the game files.
- For `web`: the `docker` CLI and a daemon it can reach. The Playwright image is pulled on first use.

The Minecraft client downloads the game files from Mojang's official endpoints (and the Fabric loader from
Fabric's) into the cache directory; nothing is redistributed with this repository. Offline singleplayer works
without an account. Joining an online-mode server needs a legitimately owned Minecraft account; you log in to it
yourself with `agent-lens mc login`.

## Install

```sh
git clone <this repository> agent-lens
ln -s "$PWD/agent-lens/bin/agent-lens" ~/.local/bin/agent-lens    # any directory on PATH

agent-lens mc install         # game files, about 1 GB, once
agent-lens/mod/install.sh     # builds the lens mod (JAVA_HOME = a JDK 25) and puts it into the game directory
agent-lens doctor             # one line per prerequisite
```

The two npm dependencies (`prismarine-auth` for the Microsoft login, `playwright` for web) are pinned in
`cli/mc/package.json` and `web/package.json` and installed on first use into the cache, not into the repository.

## First steps

```sh
# Minecraft: open a flat creative world, look at the inventory screen
agent-lens mc singleplayer demo --create-flat --create-creative
agent-lens mc key key.inventory
agent-lens mc capture screen --pad 8 --out shots/inventory.png
agent-lens mc stop

# Web: does the page render, and how does it look on a phone?
agent-lens web snapshot --url http://127.0.0.1:3000/
agent-lens web shot --url http://127.0.0.1:3000/ --viewport mobile,desktop --out shots/web
```

Reference: [docs/usage.md](docs/usage.md) (`mc`), [docs/usage-web.md](docs/usage-web.md) (`web`),
[docs/forges.md](docs/forges.md) (`pr`), [docs/config.md](docs/config.md) (config file),
[docs/api.md](docs/api.md) (HTTP API of the mod), [mod/README.md](mod/README.md) (mod code map).

## Configuration

`~/.config/agent-lens/config.json`, every key optional. Without a file the tool works for singleplayer and for
web; servers, an account and forges are things you add. A neutral example:

```json
{
  "servers": {
    "dev": { "host": "127.0.0.1", "port": 25565, "auth": "offline" },
    "staging": { "host": "play.example.net", "port": 25566, "auth": "microsoft" }
  },
  "account": { "name": "ExamplePlayer" },
  "forges": {
    "gh": { "type": "github", "auth": { "type": "gh" } },
    "git": { "type": "forgejo", "api": "https://git.example.net/api/v1",
             "auth": { "type": "token-env", "env": "FORGEJO_TOKEN" } }
  }
}
```

All keys, defaults and environment variables: [docs/config.md](docs/config.md).

## Layout

```
bin/agent-lens     wrapper: picks Node 22+, runs cli/main.mjs
cli/main.mjs       dispatch and help
cli/core/          config, paths, state files, argument and output helpers; used by every module
cli/mc/            Minecraft: downloads, launcher, login, HTTP API client, scenes
cli/web/           web, host side: spec expansion, the docker run, results
cli/forge/         pull request providers behind one small interface, markdown table
web/               scripts that run inside the Playwright container
mod/               the Fabric mod "lens" (Gradle, Java 25): the HTTP API inside the client
docs/              reference
```

`mc` and `web` do not depend on each other; both use `core`. Data lives outside the repository:
`~/.cache/agent-lens/` (game files, game directory, npm packages), `~/.config/agent-lens/` (config, login cache),
runtime state in `$XDG_RUNTIME_DIR/agent-lens` or `/dev/shm`, the client log in `~/.local/state/agent-lens/`.

## Safety

- **Production guard.** The client only joins servers listed in the config, each with an explicit host and port.
  A bare host name is always refused, because without a port the client would follow the SRV record. The mod
  enforces the same list. Do not add production servers.
- **Tokens are never printed.** The Minecraft access token exists only in the login cache and in the command line
  of the running client (`mc command` prints `<redacted>`). Forge tokens come from an environment variable, from
  `gh`, or from a proxy that adds them; `--dry-run` shows requests with the credentials replaced.
- **No login without being asked.** A normal command only refreshes an existing login silently. The device code
  login is the explicit `agent-lens mc login`.
- **Writes to a forge are explicit commands** (`pr upload`, `pr comment`, `pr description`), each with `--dry-run`.

## Pinned versions

Minecraft 26.3, Java 25, Fabric Loader 0.20.1 (in `cli/core/config.mjs`), Playwright in `web/package.json`,
prismarine-auth in `cli/mc/package.json`.

## Status and license

Early and changing: commands, flags and the HTTP API can change without notice. [MIT](LICENSE).
