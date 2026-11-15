# agent-lens: configuration

One JSON file, `~/.config/agent-lens/config.json` (`$XDG_CONFIG_HOME` is honoured), every key optional. The
defaults are neutral: no servers, no forges, no account name, no machine paths. `agent-lens doctor` shows what is
in effect. Paths may start with `~/`.

## Minecraft client

| Key | Default | Meaning |
|---|---|---|
| `java` | none | java binary. Without it: `$JAVA_HOME/bin/java`, then `java` on PATH, then the JDKs under `~/.jdks`; the first one that is at least the version the game asks for (25 for Minecraft 26.3) is used. An explicit `java` that is too old is an error that says what was found. |
| `username` | `agent_lens` | player name of an offline session |
| `offline` | `true` | session of a client started without a server in mind: offline, or (`false`) the Microsoft account |
| `width`, `height`, `guiScale`, `maxFps` | 1280, 720, 2, 30 | window (= framebuffer) size, GUI scale, frame limit |
| `xmx`, `cpus` | `3G`, 4 | heap limit and `-XX:ActiveProcessorCount` |
| `backend` | `opengl` | `opengl` or `vulkan` |
| `idleMinutes` | 10 | the client exits after this long without an API request (0 = never) |
| `port` | 0 | API port on 127.0.0.1, 0 = any free port |
| `env` | `SDL_VIDEODRIVER=offscreen`, `ALSOFT_DRIVERS=wave` | environment of the client; a key set to `null` is removed. `ALSOFT_DRIVERS=wave` is what `mc record` needs (the mix goes to `/dev/null` unless a recording runs); `"null"` (the string) discards the mix and disables recording |
| `ffmpeg` | none | ffmpeg binary for the MP4 of `mc record --video`. Without it: `ffmpeg` on PATH; with neither, the frames and the WAV are kept |
| `jvmArgs`, `gameArgs` | `[]` | extra arguments |
| `minecraft`, `fabricLoader` | pinned in `cli/core/config.mjs` | versions; the mod is built for the pinned ones |

### servers

```json
"servers": {
  "dev": { "host": "127.0.0.1", "port": 25565, "auth": "offline" },
  "staging": { "host": "play.example.net", "port": 25566, "auth": "microsoft",
               "resourcePack": "~/packs/server-pack" }
}
```

The only servers `connect` accepts, by name or by the exact `host:port`. `port` is mandatory. `auth` is the
session the server needs (`offline` or `microsoft`). `resourcePack` is a pack directory or zip that `connect`
applies before joining, for servers that send none. Default: no servers.

### account

```json
"account": {
  "name": "ExamplePlayer",
  "cacheDir": "~/.config/agent-lens/auth",
  "cacheKey": "agent-lens",
  "authflow": { "flow": "live", "authTitle": "MinecraftNintendoSwitch", "deviceType": "Nintendo" },
  "conflicts": [
    { "name": "my-bot", "cwd": "~/projects/my-bot", "command": "node", "unlessEnv": "BOT_AUTH=offline" }
  ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `name` | none | expected profile name. When set, a login cache holding another account is refused. Without it any account is accepted and its name is printed when the client starts. |
| `cacheDir` | `<config dir>/auth` | [prismarine-auth](https://github.com/PrismarineJS/prismarine-auth) token cache |
| `cacheKey` | `agent-lens` | the Authflow user name; the cache file names are derived from it |
| `authflow` | values shown above | Authflow options. `authTitle` is the name of a prismarine-auth title or a client id. |
| `conflicts` | `[]` | other programs that use the same account, see below |

**Sharing a login with another tool.** Programs built on prismarine-auth (mineflayer bots, for example) keep the
same kind of cache. Point `cacheDir` at that directory, set `cacheKey` to the user name that program passes to
`Authflow` and `authflow` to its options, and both use one login without a second device code. The values must
match exactly, otherwise other cache files are used and a new login is asked for.

**Conflicts.** An account can only be online once. An entry names a program that uses the account: a running
process whose working directory or one of whose arguments lies inside `cwd`, whose program name matches the
regular expression `command` (optional), and whose environment does not contain `unlessEnv` (optional,
`KEY=value`). While such a process runs, `connect` to a `microsoft` server is refused (`--force` overrides).

## web

```json
"web": {
  "docker": {
    "env": { "DOCKER_HOST": "tcp://127.0.0.1:2376", "DOCKER_TLS_VERIFY": "1", "DOCKER_CERT_PATH": "/certs/client" },
    "args": ["--context", "remote"]
  },
  "mountRoot": "/srv/shared"
}
```

| Key | Default | Meaning |
|---|---|---|
| `docker.env` | `{}` | environment for the `docker` CLI. A variable that is already set in the environment wins. |
| `docker.args` | `[]` | arguments placed before the docker subcommand |
| `mountRoot` | the home directory | directory (or list of directories) the Docker daemon can bind-mount at the same path. Output and input directories below it are mounted directly; others are staged through the cache. The cache directory itself must be below it. |

Without this section the docker CLI is used as it is set up for your shell.

## forges

`"forges": { "<name>": { "type": ..., "api": ..., "auth": ... } }`, see [forges.md](forges.md). Default: none.

## Environment variables

| Variable | Meaning |
|---|---|
| `AGENT_LENS_CONFIG` | another config file |
| `AGENT_LENS_CACHE` | another cache directory (default `~/.cache/agent-lens`, `$XDG_CACHE_HOME` honoured) |
| `AGENT_LENS_STATE_DIR` | another state directory: with `AGENT_LENS_GAME_DIR` a second, independent client instance |
| `AGENT_LENS_GAME_DIR` | another game directory (worlds, `mods/`, `options.txt`) |
| `AGENT_LENS_LOGIN_RETRY_MS` | pause between login retries of `connect` (default 20000) |

## Where files go

| What | Where |
|---|---|
| config, own login cache | `~/.config/agent-lens/` |
| game files, game directory, npm packages, web staging | `~/.cache/agent-lens/` |
| runtime state (`client.json`, `mod.json`, start lock; a few hundred bytes) | `$XDG_RUNTIME_DIR/agent-lens`, else `/dev/shm/agent-lens-<uid>` when `/dev/shm` is a tmpfs, else `~/.local/state/agent-lens` |
| client log | `~/.local/state/agent-lens/client.log`, on disk so that it survives a crash; truncated at every client start, so it holds one run |
| results | only where `--out` points |
