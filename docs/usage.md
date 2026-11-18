# agent-lens mc: CLI reference

A real Minecraft client driven from the command line, for looking at what a plugin, mod or datapack change does
and for before/after screenshots in pull requests. Written for an agent: every command is one shot, prints compact
text (raw JSON with `--json`), and exits non-zero with the reason on stderr.

- `agent-lens mc ...`: this file.
- `agent-lens web ...`: web pages, see [usage-web.md](usage-web.md).
- `agent-lens pr ...`: images into a pull request, see [forges.md](forges.md).
- `agent-lens doctor`: prerequisites, one line per check. `agent-lens help mc|web|pr`: command lists.
- Config file: [config.md](config.md).

The HTTP API behind `agent-lens mc` (fields, regions, results) is [api.md](api.md). The CLI adds little to it: a
command is `POST /<command>` (GET for `screen`, `hud`, `regions`, `status`) and flags are the body fields. Only
`connect` does more (server names, session, resource pack, login retry).

## Lifecycle

- **Auto-start.** The first API command starts the client if it is not running (downloads on first use, then about
  10 s to the title screen) and waits until the API answers. `agent-lens mc start` is never required.
- **Idle exit.** The client stops itself 10 minutes after the last API request (`idleMinutes`). Nothing else runs:
  no daemon, no server. `agent-lens mc stop` ends it at once, `agent-lens mc quit` asks it to shut down cleanly.
- **Footprint while running:** about 1.2 to 1.7 GB RSS, about 6 % of one core while nothing is asked of it (10 fps
  between requests, 60 around them; 4 cores max, `-Xmx3G`), hardware rendering on the GPU render node without a
  display server. Stop it when the evidence is done instead of waiting for the idle exit.
- A local world is saved by `disconnect`, `quit`, the idle exit and also by `stop` (the client handles the signal).
- **Files:** the CLI and the client talk over loopback HTTP; files are only state and results. Runtime state
  (`client.json`, `mod.json`, a start lock) lives in memory (`$XDG_RUNTIME_DIR/agent-lens`, else
  `/dev/shm/agent-lens-<uid>`). The client log is `~/.local/state/agent-lens/client.log`: on disk so that it is
  still there after a crash, and truncated at every client start, so it never holds more than one run. Game
  directory `~/.cache/agent-lens/game` (worlds, `mods/`, `options.txt`). A capture writes one PNG; a scene run
  writes its captures plus one `manifest.json` and nothing per step (measured: 3 captures, 4 files, 58 KB).
- **Second instance:** `AGENT_LENS_STATE_DIR=<dir> AGENT_LENS_GAME_DIR=<dir> agent-lens mc ...` runs an independent
  client (own port, log, worlds, mods). Put the lens jar into `<game dir>/mods/`. Downloads stay shared.

```sh
agent-lens mc status        # process, session, and the game state when the API is up; "not running" + exit 1
                            # otherwise (state files left by an idle exit, quit or crash are removed)
agent-lens mc logs -n 80    # tail of the client log
agent-lens mc stop
```

## Commands

Mapping rule: `--gui-scale 4` is `guiScale: 4`; a flag starting with `hover`, `create`, `fixed` or `window` goes
one level down (`--hover-slot 13` is `hover: {slot: 13}`); a flag without value is `true`; `1,64,-3` is a number
list; a value starting with `{` or `[` is JSON. Unknown flags are passed through, so a new API field needs no CLI
change. A flag takes the next argument as its value unless it is a known switch (`--clear`, `--shift`, `--none`,
`--hold-hud`, `--toasts`, ...): a switch only takes `true` or `false`, so `type --clear new text` works. For a
new boolean field write `--flag=true`. `--out`, `--before`, `--after` are made absolute. CLI-only flags: `--json`,
`--no-start` (fail instead of starting the client), `--http-timeout <s>`.

```sh
# world
agent-lens mc singleplayer evidence --create-flat --create-creative   # opens the world, creates it if missing
agent-lens mc connect dev                  # a configured server name (or its exact host:port)
agent-lens mc disconnect                       # leaves the world or server, saves a local world
agent-lens mc wait ready                       # world joined, chunks compiled, packs applied, hand at rest
agent-lens mc wait screen [match] --timeout-ms 10000    # match: part of the screen's class name or title
agent-lens mc wait noscreen | wait ticks 20
agent-lens mc wait chat 'Gave \d+ '            # regular expression, lines since the last chat command (--from-now)
agent-lens mc resourcepack ~/packs/server-pack    # local pack on top; --clear removes it

# act
agent-lens mc chat /punish history Notch       # prints the feedback lines; text after "--" is literal: chat -- --x
agent-lens mc chat --clear                     # empties the chat HUD
agent-lens mc key escape                       # key e | key key.inventory down; escape without a screen = pause menu
agent-lens mc type Klinge des Nordens          # into the focused or first text input; --widget Name, --clear
agent-lens mc click --slot 13 [--button right] [--shift] [--double]    # or --x 120 --y 80, or --widget Done
agent-lens mc click --item 'Private Server'    # by item name (case-insensitive regex) instead of a slot number
agent-lens mc hover --slot 13                  # virtual mouse, makes the tooltip render; --none clears it
agent-lens mc hover --item Minuten             # prints the hovered item and its tooltip lines
agent-lens mc hover --text ':smile:'           # onto text drawn on screen (chat component, dialog); also click --text
agent-lens mc use block | attack entity | hotbar 0
agent-lens mc look --yaw 90 --pitch 0          # or --at 10,64,-3
agent-lens mc camera back --fixed-pos 0,70,0 --fixed-yaw 180 --fixed-pitch 10 --fov 70 --hide-hud
agent-lens mc camera --fixed-pos 3,66,3 --fixed-at 0.5,65,0.5    # look-at instead of yaw and pitch
agent-lens mc camera --reset                   # also: --hide-hand, --hide-player
agent-lens mc settings --gui-scale 2 --window-w 1280 --window-h 720 --time freeze
agent-lens mc settings --language de_de        # client language (reloads, is saved, the server is told)
agent-lens mc settings --hold-hud              # action bar and title stay instead of fading; --hold-hud false ends it

# read (use these, never a screenshot, to see which screen is open and what is on it)
agent-lens mc screen --brief   # title, widget labels, one "slot  item name" line per named container item
agent-lens mc screen        # everything: rects, lore and tooltip lines of every slot
agent-lens mc expect --screen Timer --item Minuten --tooltip 'Shift'   # waits up to --timeout-ms 5000 until all
                            # hold, else exit 1 and one line with what is there instead; also --no-screen,
                            # --widget RE, --chat RE, --text RE (any drawn text). Replaces "wait + look".
agent-lens mc texts         # every text drawn right now with its GUI position: dialogs, books, chat, tooltips
agent-lens mc hud           # chat lines, action bar, title, boss bars, sidebar; --lines 50 for more chat
agent-lens mc regions       # region rects that can be captured right now

# capture
agent-lens mc shot tooltip --item Minuten --gui-scale 3 --out shots/tooltip.png   # the evidence shot, see below
agent-lens mc capture screen --out shots/menu.png --pad 8
agent-lens mc capture screen tooltip --hover-slot 13 --gui-scale 4 --out shots/tooltip.png   # union of two regions
agent-lens mc capture actionbar --pad 8 --gui-scale 3 --out shots/actionbar.png
agent-lens mc capture '{"x":0,"y":0,"w":400,"h":300}' --out shots/corner.png
agent-lens mc frames full --count 20 --interval-ticks 2 --format gif --out shots/particles.gif
agent-lens mc compose --before a.png --after b.png --out ab.png --labels Vorher,Nachher --layout row --scale 2

# sound (see "Sound" below)
agent-lens mc record start --out shots/jingle.wav [--video hotbar]   # start first, then trigger the sound
agent-lens mc record stop                                            # jingle.wav + jingle.png (+ jingle.mp4)

# anything else
agent-lens mc api GET /status
agent-lens mc api POST /settings guiScale=3 window.w=800 window.h=600    # or one JSON argument, or @body.json
```

Regions: `full`, `screen`, `slot:<n>`, `slots:<a>-<b>`, `tooltip`, `screen+tooltip`, `widget:<label>`, and the HUD
parts `chat`, `actionbar`, `title`, `sidebar`, `bossbar`, `hotbar`, `status` (hotbar with hearts, food,
experience), `tablist`, `effects`, `crosshair`. A region that is not on screen is an error that names the regions
that are.

Things the API does that are easy to miss:

- **`--pad` defaults to 0** (framebuffer pixels). A little padding (8) reads better in a pull request.
- **`--gui-scale` on a capture** applies to that shot only and is the sharp way to enlarge GUI evidence. GUI space
  is window / scale: at 1280x720, scale 4 leaves 320x180 GUI pixels, and a creative inventory or a tall tooltip is
  cut off at the frame edge. Enlarge the window first: `settings --window-w 1600 --window-h 1200`.
- **Chat lines are left out of a capture** unless the region is `full`, `chat` or a pixel rect: they overlap the
  action bar, show through behind screens and differ between runs. `--chat true` / `--chat false` overrides.
- **Showing chat messages: `capture chat`** (chat closed, the way a player sees incoming messages). For that shot
  the tool does two things the game would not: the lines are drawn as they were when the newest one arrived, even
  if the 10 s after which closed chat hides them are long over, and every HUD part that can lie on top of them
  (action bar, title, item name, crosshair, sidebar, tab list, boss bar, effects) is left out unless the region
  list names it (`capture chat actionbar`). A `full` shot stays plain vanilla: lines fade, the action bar overlaps
  them. `settings --hold-hud` keeps the lines in every shot. Run `chat --clear` first so only the messages under
  test are there.
- **The chat input field belongs in a shot only when the change is about typing**: command suggestions, tab
  completion, a prefilled command from a click event, clickable or hoverable text (hover needs open chat), chat
  history beyond the last lines. Then `key t` (or `key /`), `type ...`, `capture chat`: with the chat open the
  region is the lines plus the input field and its suggestion popup. For "the server sent this message" keep it
  closed.
- **`chat` returns the feedback** of a command (`chat: [...]`), including errors such as an unknown command, so a
  scene step can be checked without a capture. `wait chat <regex>` waits for a later line.
- **Slot indices are those of the open menu.** In a creative inventory they are not the survival ones (slot 36 is a
  creative tab entry, not the first hotbar slot): read them from `agent-lens mc screen`.
- **Toasts are off** (advancements, recipes, "Chat messages can't be verified"), **the text cursor is not drawn**
  and the held item name popup is off, all for reproducible shots: `settings --toasts`, `--text-cursor`,
  `--item-name` turn them on.
- **The hand:** `singleplayer`, `connect`, `hotbar` and `wait ready` return when the first-person hand has stopped
  moving. After a `/give` into the selected slot add `wait ready`. The held item is drawn at vanilla size (it is
  large at 16:9); `camera --hide-hand` removes it from a shot.
- **A chest lid** is still opening when the chest screen appears and shows around the panel with `--pad`:
  `wait ticks 20` first.
- **Text output escapes characters a terminal cannot show** (private-use glyphs of a server pack, control
  characters) as `\u{f200}`. `--json` prints the raw text; `screen` also returns `titleJson`.

### Local resource pack

A server that sends no resource pack (a local test server, for example) renders custom font glyphs as boxes.
Apply the pack locally:

```sh
agent-lens mc resourcepack ~/packs/server-pack   # directory with pack.mcmeta, or a .zip
#   pack: file/agent-lens-local   reloaded: true   ms: 3230
agent-lens mc resourcepack --clear
```

The pack is copied into the game directory, enabled above all other packs and the command returns when the
resources are reloaded (about 3 s). Repeating it with an unchanged pack costs nothing. It lasts until `--clear` or
until the client stops. To have `connect` apply it before joining, set it per server:

```json
{ "servers": { "dev": { "host": "127.0.0.1", "port": 25565, "auth": "offline",
                        "resourcePack": "~/packs/server-pack" } } }
```

### Sound

`record` captures exactly what the game mixes (48 kHz stereo), for sound features and for checking their timing.
Start it **before** the action that makes the sound, stop it when the sequence is over:

```sh
agent-lens mc record start --out shots/jingle.wav          # add --video [region] for picture + sound
agent-lens mc chat /playsound minecraft:block.note_block.pling master @s
agent-lens mc wait ticks 20
agent-lens mc record stop
#   file: shots/jingle.wav   image: shots/jingle.png   durationMs: 1355   peakDb: -13.2   silent: false
#   onsets: [{ms=50 db=-13.9}]                     where sound starts in the recording (measured)
#   sounds: [{ms=43 tick=1 id=minecraft:block.note_block.pling source=master volume=1 pitch=1 pos=[...]}]
```

- **Read the result, you cannot listen.** `sounds` lists every sound the game started (id, resolved file,
  category, volume, pitch, position) with its time in the recording; `onsets` are the moments the level actually
  rises, `firstSoundMs`/`lastSoundMs` the audible span. A sound becomes audible 3 to 25 ms after its `sounds`
  entry (the first use of a sound file loads it). `silent: true` means nothing was audible.
- **Timing.** Times come from the sound device's sample clock: positions are exact to about 5 ms and do not depend
  on how long the commands around them take. `ms 0` is the moment `record start` returned. What does vary by some
  10 ms is when a separate CLI command reaches the game: for a tight sequence let the server or one command
  produce it, and use `wait ticks` between steps rather than `sleep`.
- **`<name>.png`** is the waveform: grid line per tick (labelled every 10), orange markers for the game's sounds
  (`x2` = pitch), red ticks for onsets. Drawn relative to the loudest sample; the header names the real peak. This
  is what goes into a before/after table, with the recording linked next to it.
- **`--video [region]`** (default `full`) also grabs a frame every `--interval-ticks` (default 2). With ffmpeg
  (`ffmpeg` on PATH or config `ffmpeg`) the result is `<name>.mp4`, picture and sound aligned by the same clock;
  without it the frames stay in `<name>.frames/` in the state directory (memory-backed where available; the
  result names it) and the result says `videoSkipped`.
- Background music is off (`soundCategory_music` 0), every other category plays. A recording that is not stopped
  ends itself after 120 s and is discarded. Between recordings nothing is written.
- Two waveforms of the same scene are never pixel-identical (command timing), so `scene compare` always reports
  a recording as changed: compare the `onsets` and `sounds` of the two manifests.

## Servers and the production guard

The client can only join servers listed in the config, each with explicit host **and** port:

```json
{
  "servers": {
    "dev": { "host": "127.0.0.1", "port": 25565, "auth": "offline" },
    "staging": { "host": "play.example.net", "port": 25566, "auth": "microsoft" }
  }
}
```

There are no built-in servers: without this section only singleplayer works, and `connect` says so. `connect`
takes a configured name or its exact `host:port`. A bare host is always refused: without a port the client would
follow the SRV record, which can end on production. The mod enforces the same list (`-Dagentlens.allow`, only the
servers that fit the session of the running client). Do not add production.

`auth` is the session the client needs. A client runs with one session for its lifetime:

- `offline`: player `agent_lens` (config `username`), no requests to the Mojang services. Default for auto-start
  and singleplayer.
- `microsoft`: a real account from the login cache. `connect staging` starts the client that way. If a client with
  the other session is running, the command fails and names `--restart`, which stops and restarts the client.

Right after a Microsoft-session start the session server can refuse the login (`Failed to log in: Status: 429`),
and a proxy refuses quick reconnects ("You are logging in too fast"). `connect` retries both up to three times,
20 s apart, and says so on stderr; this holds for a scene's `connect` step too.

## Account

- Online-mode servers need a legitimately owned Minecraft account. `agent-lens mc login` is the one command that
  starts a login: it prints a device code and a URL, the owner of the account signs in in a browser, and the
  tokens are stored in the login cache (`~/.config/agent-lens/auth`, config `account.cacheDir`).
- Every other command only refreshes that login silently. If it cannot be refreshed, the command fails and says
  so; then ask the user to run `agent-lens mc login`. Never start a login on your own.
- `account.name` in the config pins the expected profile name: a cache holding another account is refused. Without
  it any account is accepted and its name is printed when the client starts.
- **One account, one session.** The same account online twice kicks one of the two. Programs that use the account
  can be listed in `account.conflicts`; an online `connect` is refused while one of them runs. `--force` only if
  that process is known to be offline. Sharing a login cache with such a program: [config.md](config.md).
- The access token exists only in the cache and in the java command line of the running client. `agent-lens mc
  command` prints `<redacted>`. Never paste a process listing of the client into a report.
- Use the real account only where it is needed (online-mode servers). Develop the scene in singleplayer or on an
  offline test server first.

### shot: the evidence capture

`mc shot <target>` is `capture` with the defaults evidence needs, in one call: it hovers the item by name, waits
for the tooltip, crops to what the game really drew, and enlarges the window for the shot when the content would
not fit at the wanted GUI scale (`fit`), so a long lore or a large menu is never cut off.

| Target | Picture |
|---|---|
| `menu` (default) | the open screen's panel |
| `tooltip` | only the tooltip of `--item NAME` / `--slot N` / `--widget L` / `--text RE` (a chat hover: open the chat first) |
| `item` | the slot and its tooltip |
| `menu+tooltip` | panel and tooltip together |
| `menu-title` | a container's title as the frame shows it (see below) |
| `menu-head` | the title across the panel's full width, down to just below it: the title in proportion to the menu (evidence for a title change) |
| `panel` | a container's panel alone, without what the screen draws around it |
| anything else | that region: `chat`, `actionbar`, `sidebar`, `title` (the HUD title), `hotbar`, ... |

```sh
agent-lens mc shot tooltip --item Minuten --gui-scale 3 --out ev/tooltip.png
#   ev/tooltip.png  427x177  guiScale 3
#   fitted: the window was 854x598 for this shot
#   hovered: slot 36 Minuten
#     | Minuten
#     | Linksklick +1
#     | Shift + Linksklick +10
```

The printed lines are what the picture shows: check them instead of opening the PNG, and open only the final
comparison. `CLIPPED: ...` means the content is larger than the largest window: lower `--gui-scale`. Defaults:
`--pad 8`, `--fit true`; every `capture` flag works.

**Container titles are measured from the frame.** A resource pack's text shader may draw the title somewhere
else than its layout says (a title plate lifted above the panel), which no layout bounds show. For a `screen` or
`menu-title` region the shot renders two more frames, one without the title and one with it again, and takes
the pixels the title changes (minus those that changed anyway). `screen` grows to include them; `menu-title` is
exactly them, so its width follows the title's real length. A measured title touching the window edge is
reported as `CLIPPED: menu-title`. Every capture with an open screen also reports `screenTitle`: the title as
text without private-use glyphs, what a before/after check compares when a change is in the title.

## Scenes

One JSON file per piece of evidence, replayed unchanged against the base build and the PR build. A step is an
object with one key: the command name and its body (a plain value fills the first positional field).

```json
{
  "name": "punish-history",
  "steps": [
    { "connect": "$server" },
    { "wait": "ready" },
    { "settings": { "guiScale": 2, "time": "freeze" } },
    { "chat": "/punish history Notch" },
    { "wait": { "for": "screen", "timeoutMs": 10000 } },
    { "capture": { "region": "screen", "name": "history", "pad": 8 } },
    { "capture": { "region": ["screen", "tooltip"], "name": "history-tooltip", "hover": { "slot": 13 },
                   "guiScale": 4 } },
    { "key": "escape" }
  ]
}
```

- Steps: every API command (`singleplayer`, `connect`, `resourcepack`, `chat`, `type`, `wait`, `hover`, `click`,
  `camera`, `settings`, `capture`, `frames`, ...), plus `{"sleep": <ms>}` and
  `{"api": {"method": "POST", "path": "/x", "body": {}}}`.
- `{"shot": {"target": "tooltip", "item": "Minuten", "name": "minutes"}}`: `mc shot` as a step, file
  `<out>/minutes.png`. Prefer it over `capture` with slot numbers: a name survives a menu being rearranged.
- `{"expect": {"screen": "Timer", "item": "Minuten"}}`: fails the run with a text message when the scene is not
  where it should be (wrong menu, missing permission, item gone), instead of capturing the wrong thing. Put one
  after every step that opens a screen; it waits like `wait` does, so no extra `wait` or `sleep` is needed.
- `{"include": "route.json"}`: the steps of another scene in place, relative to the including file (`~/` works).
  Keep the way to a place (join, open the menu, `expect` it) in a route file and include it from every evidence
  scene for that place.
- `{"resourcepack": "<path>"}` resolves a relative path against the working directory; `~/` is expanded.
- `capture` and `frames` need `name`; the file is `<out>/<name>.png` (`.gif` for gif frames). No `out` field.
- `{"record": {"action": "start", "name": "jingle", "video": "hotbar"}}` ... `{"record": "stop"}` records sound
  (and optionally a video) around the steps in between: `<out>/jingle.wav`, the waveform `jingle.png`, with ffmpeg
  `jingle.mp4`. `scene compare` pairs the waveforms like any capture, and `pr ... --compare` links the recordings.
- `{"connect": "$server"}` takes the server from `--server`; `--server` also overrides a fixed name.
- Prefer `wait` steps over `sleep`: a wait returns when its condition is visible.
- A scene must bring the world into its start state itself (`/clear`, `/gamemode`, `/setblock`) before the first
  capture: the second run starts from what the first one left behind.

```sh
agent-lens mc scene run scenes/history.json --out evidence/before --server dev
#   ok   6 capture history.png  640x440  rect 320,100 640x440
#   8 steps, 0 failed, 2 captures -> evidence/before/manifest.json
```

The run stops at the first failing step (`FAIL <index> <step> <error>`, exit 1); `--keep-going` runs the rest.
A failure also prints the last chat lines (the server's answer: no permission, unknown command) and the command
to resume: fix the step, then `scene run ... --from <index>` continues from where the client stands, keeping the
earlier captures of the manifest in `--out`. `CLIPPED: <capture> (<region>)` at the end names pictures with
content cut off.

**Writing a new route: record it, do not write it from the code.** `mc scene record start <scene.json>
[--include route.json]` turns recording on (state in the state dir); from then on every `mc` action that succeeds
(`chat`, `click`, `expect`, `wait`, `shot`, ...) is appended as a step, read-only lookups (`screen`, `hud`) are
not. A command that fails is not recorded, so the file only holds steps that worked against the live server.
`shot`/`capture` steps take their `name` from `--out`. `scene record stop` ends it; then replay the file.
`manifest.json` lists every step (`ok`, `ms`, `error`) and per capture the API result (`width`, `height`, `rect`,
`regions`, `guiScale`).

```sh
agent-lens mc scene compare --before evidence/before --after evidence/after --out evidence/compare
#   changed  history  -> history.compare.png
#   same     hotbar  -> hotbar.compare.png
#   2 pairs, 1 changed, 0 failed -> evidence/compare/compare.json
```

For every PNG name present in both directories this writes `<name>.compare.png` (labelled side by side, composed
by the mod) and reports `same` (byte-identical files) or `changed`. `--labels A,B` (default `Vorher,Nachher`,
German for before and after), `--layout row|column`,
`--scale N`. With `--pixel-diff` the comparison runs through `agent-lens web compare` instead (Docker, no client):
changed pixel counts, bounding box and `<name>.diff.png`.

## Worked example: before/after for a plugin change

```sh
# 0. once per machine
agent-lens doctor

# 1. write the scene while exploring on the PR build
agent-lens mc connect dev && agent-lens mc wait ready
agent-lens mc chat /punish history Notch && agent-lens mc expect --screen History
agent-lens mc screen --brief                           # titles and item names, as text
agent-lens mc shot menu+tooltip --item Notch --gui-scale 4 --out /tmp/try.png    # prints the tooltip lines
#    then put the steps into scenes/history.json

# 2. base build: check out the target branch, build, deploy to the test server, then
agent-lens mc scene run scenes/history.json --out evidence/before --server dev

# 3. PR build: check out the PR branch, build, deploy to the test server, then
agent-lens mc scene run scenes/history.json --out evidence/after --server dev

# 4. into the pull request: a Vorher/Nachher table at the end of the description
agent-lens mc stop
agent-lens pr evidence --repo owner/name --pr 42 --before evidence/before --after evidence/after

# later, when the change was reworked: only step 3 again, then
agent-lens pr evidence --repo owner/name --pr 42 --after evidence/after     # replaces the Nachher cells only
```

"Before" is the target branch and does not change while the pull request is open: record it once. `scene compare`
is for looking at pairs locally (stitched image, `same`/`changed`); the table needs neither it nor its output.
A route scene shared by several evidence scenes should set what it depends on in its first steps
(`{"settings": {"language": "de_de"}}` before `connect`) instead of relying on what the last run left behind,
and a scene may start with `{"disconnect": {}}` on a stopped client: the step is a no-op then.

Singleplayer variant (client-side or datapack-level changes, or a plugin that is not involved): replace the
connect step by `{"singleplayer": {"world": "evidence", "create": {"flat": true, "creative": true}}}` and drop
`--server`. The world persists in the game directory, so both runs see the same blocks; end the scene with
`{"disconnect": {}}` so the next run opens it again from disk. The same scene run on a fresh world and again on
the reopened one gives byte-identical inventory, tooltip and HUD crops. For an online-mode server use its name
(`--server staging`, real account, see above); a server restart between the two runs disconnects the client, the
scene's `connect` step joins again.

Checks before publishing: read the PNGs, confirm both runs captured the same names and sizes (`manifest.json`),
and that `same` / `changed` matches what the change should do.

## Worked example: a new feature

A new menu, command or item has no "before": the target branch shows nothing to compare. Record only the PR build,
with one capture per perspective or state, named for what it shows, in the order a reviewer should read them:

```sh
# scenes/warps-new.json: connect, open the menu, shot "menu"; hover an entry, shot "entry-hover";
# click it, shot "confirm-dialog"; confirm, shot "chat-result"
agent-lens mc scene run scenes/warps-new.json --out evidence/new --server dev
agent-lens pr evidence --repo owner/name --pr 42 --new evidence/new
#   | | Neu |
#   |---|---|
#   | `menu` | ![Neu: menu](<url>) |
#   | `entry-hover` | ...
```

The rows keep the scene's capture order. Shots from separate commands go in as several `--new <file>` in the
order wanted. A rerun after a rework replaces the rows of the same names and adds new ones. Two identical shots
are refused: a state the scene meant to change did not change. A pull request that also changes something
existing gets its Vorher/Nachher table from a separate `pr evidence --before ... --after ...` run.

## Pull request upload and config

`agent-lens pr` (OneDev, GitHub, Forgejo/Gitea): [forges.md](forges.md). Config file and environment variables:
[config.md](config.md).

## Troubleshooting

| Symptom | Cause, fix |
|---|---|
| `no lens mod jar in .../mods` | run `mod/install.sh` from the repository (builds the mod, copies the jar to `~/.cache/agent-lens/game/mods/`) |
| `client exited, from the log: ...` | the JVM died while starting; the message carries the exception, mixin and error lines of the log (a mixin `InvalidInjectionException` means the lens jar does not fit the game version: rebuild with `mod/install.sh`). More: `agent-lens mc logs -n 100`, `agent-lens doctor` |
| `lens API at ... failed (ECONNREFUSED)` | the client went away between two calls (idle exit, crash); repeat the command, it starts again |
| `runs with session "offline", this needs "microsoft"` | repeat with `--restart`; the current world or connection is lost |
| `refused: "<host>" is neither a configured name nor host:port` | use a name from `servers`; add the server with its port to the config if it is a test target |
| `refused: <name> (pid N) is running and uses the same account` | a program from `account.conflicts` is online: stop it, then repeat |
| `no Java 25 or newer for the client: found ...` | install a JDK 25 or set `java` in the config to its `bin/java` |
| `cached Microsoft login ... cannot be refreshed` | ask the user to run `agent-lens mc login` |
| `the login cache holds account "X", expected "Y"` | wrong account in the cache; do not continue, ask the user |
| capture error naming other regions | the screen or tooltip is not there yet: add a `wait`, check `agent-lens mc regions` |
| shots differ although nothing changed | see "Reproducible shots" in [api.md](api.md): chat lines in a `full` shot, particles, a chest lid, world state left by the previous run. Otherwise freeze time (`settings --time freeze`), fix the camera, raise `settleFrames` |
| glyphs render as boxes | the server sends no resource pack: `agent-lens mc resourcepack <path>` or `servers.<name>.resourcePack` |
| a tooltip or screen is cut off at the frame edge | `--gui-scale` too large for the window: `settings --window-w 1600 --window-h 1200`, or a smaller scale |
| `Failed to log in: Status: 429` after three retries | session server rate limit; wait a minute and repeat `connect` |
| a command hangs | `agent-lens mc status` in a second shell, `--http-timeout <s>`, or `agent-lens mc stop` |
| `warn gpu` in `agent-lens doctor` | no accessible `/dev/dri/renderD*` (in a container: pass the device in); without one the client needs software GL |
