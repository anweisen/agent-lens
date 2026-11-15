# lens mod: HTTP API

The mod listens on `127.0.0.1:<port>` (port from `-Dagentlens.port`, default 0 = ephemeral) and writes
`{"port":..., "pid":..., "version":...}` to the file named by `-Dagentlens.stateFile` once the title screen is up and
the API answers. It removes that file when it stops the client itself (`/quit`, idle shutdown).

- JSON in, JSON out. Errors are `{"error": "..."}` with a 4xx/5xx status: 400 bad request, 403 server not allowed,
  404 unknown path/region/widget/world, 408 timeout, 409 wrong state (no screen, not in a world, ...), 502
  disconnected, 500 anything else. A failing request never stops the client.
- Every request resets the idle timer. After `-Dagentlens.idleMinutes` (default 10, fractions allowed, 0 = never)
  without a request the client shuts down cleanly.
- Everything that touches game state runs on the client thread, and a request returns only when its effect has been
  rendered. `POST` requests run one at a time (a second caller waits); `GET` requests, `/quit` and `/compose` do not
  wait for them.
- While no request is active the client renders at 10 fps (`-Dagentlens.idleFps`), around requests at 60
  (`-Dagentlens.busyFps`).
- All rectangles are `{x, y, w, h}` in framebuffer pixels (window size = framebuffer size), origin top left.
  Exceptions are named where they occur: `/hover` and `/click` take GUI coordinates.

## Lifecycle

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/status` | | `{state: "loading"\|"title"\|"connecting"\|"ingame", server, world, screen: {class, title}\|null, player: {name, pos: [x,y,z], yaw, pitch, dimension}\|null, window: {w, h, guiScale}, backend, renderer, fps, camera, idleSecondsLeft, version}` |
| POST | `/singleplayer` | `{world, create?: {flat?: true, creative?: true, seed?: 0}, deterministic?: true, timeoutMs?: 180000}` | opens the world, or creates it when it does not exist and `create` is given (404 without `create`). Returns `/status` plus `created`. Already in that world: returns at once. In another world: 409. |
| POST | `/connect` | `{host, port, timeoutMs?: 90000}` | joins a server. `host:port` must match an entry of `-Dagentlens.allow` exactly (comma separated; empty list refuses everything) or the answer is 403. `port` is required. Returns `/status` when `ready`, or 502 with the disconnect reason. |
| POST | `/disconnect` | | leaves the world or server (saves a local world), back to the title screen. Resets camera overrides, hover and `holdHud`. Returns `/status` plus `wasInWorld`. |
| POST | `/quit` | | `{stopping: true}`, then the client stops. |
| POST | `/wait` | `{for, match?, ticks?, timeoutMs?: 30000, fromNow?}` | see below; returns `{waitedMs, screen, line?}` or 408 |

`/singleplayer` details: `world` is both folder and level name, `[A-Za-z0-9_.-]{1,64}`. A created world is superflat
(or default terrain with `flat: false`), creative (or survival), peaceful, cheats on, without structures. With
`deterministic` (default) every open sets: time fixed at noon, weather clear and frozen, no mob, patrol, phantom or
trader spawning, random ticks 0, no advancement messages, locator bar off. On create it also removes all non-player
entities and puts the player at `0.5 <ground> 0.5`, yaw 0 (facing +z), pitch 0.

`/wait` conditions:

| `for` | Meaning |
|---|---|
| `ready` | world joined, no loading or connecting screen, no resource reload overlay, no accepted server resource pack that is still downloading or waiting to be applied (a pack is accepted without a prompt; a prompt that still appears is accepted), chunk meshing queue empty, first-person hand at rest (see below), stable for 5 frames. Disconnect during the wait: 502 with the reason. |
| `screen` | a screen is open; with `match`, its class name or title contains the text (case-insensitive) |
| `noscreen` | no screen is open |
| `ticks` | `ticks` client ticks passed (20 per second) |
| `chat` | a chat line matching the regular expression `match` arrived since the last `/chat` request (`fromNow: true`: since this request); returns it as `line` |

Hand at rest: for about 13 ticks after a join or a change of the held item the item rises into view and the attack
indicator under the crosshair fills. `ready` waits for that, so `/singleplayer`, `/connect` and `/hotbar` return
with a still hand. After a `/give` into the selected slot, `/wait {"for": "ready"}` does the same.

The server pack condition is derived from the client code (`ServerPackManager`) and was not run against a server
that sends a pack.

`/connect`: a login refused by the session server (`Failed to log in: Status: 429`) comes back as 502; the CLI
retries it. With port 25565 the host is
resolved first and the address literal is used, so no SRV lookup can redirect the connection.

## Acting

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/chat` | `{text, waitTicks?: 3}` or `{clear: true}` | sends a chat message, or a command with a leading `/`. Returns `{sent, chat: [plain text lines that arrived within waitTicks]}`, so command feedback and errors come back directly. `clear` empties the chat HUD. |
| POST | `/key` | `{key, action?: "tap"\|"down"\|"up", shift?, ctrl?}` | key binding name (`key.inventory`, `key.chat`, `key.drop`), key name (`key.keyboard.e`, `key.mouse.left`) or short form (`e`, `escape`, `enter`, `space`, `tab`, `f3`, `left.shift`). Returns `{key, screen}`. |
| POST | `/type` | `{text, widget?, clear?}` | types into a text input of the open screen: the one whose label matches `widget` (only text inputs are candidates), else the focused one, else the first. It is focused by a click. Text is appended; `clear` empties the input first. `\n` is the enter key. A screen without text inputs (sign, book) receives the characters itself. Returns `{typed, widget, value, screen}` (`value`: the input's content afterwards, null for a sign). |
| POST | `/click` | `{slot}` or `{x, y}` or `{widget: "<label>"}`, `button?: "left"\|"right"\|"middle"`, `shift?`, `ctrl?`, `double?` | click in the open screen. `x, y` are GUI coordinates (pixels / guiScale). The virtual mouse stays on the target afterwards. Returns `{screen}`. |
| POST | `/hover` | `{slot}` or `{x, y}` or `{widget}` or `{none: true}` | sets the virtual mouse (no OS input), so the tooltip renders. Persists until changed or until another screen opens. Returns `{gui: [x, y]\|null, tooltip: rect\|null}`. |
| POST | `/use` | `{target?: "item"\|"block"\|"entity"}` | right click in the world with what the crosshair is on. With `target`, 409 unless the crosshair is on that kind (`item` = on nothing). Returns `{target: {type, pos}, screen}`. `/attack` likewise (left click, one press). |
| POST | `/hotbar` | `{slot}` | select hotbar slot 0-8, returns when the hand is at rest. Returns `{slot, item}`. |
| POST | `/look` | `{yaw, pitch}` or `{at: [x, y, z]}` | turns the player (yaw 0 = +z, -90 = +x). Returns `{yaw, pitch, target}`. |
| POST | `/camera` | `{mode?: "first"\|"back"\|"front", fixed?: {pos: [x,y,z], yaw, pitch}\|{pos, at: [x,y,z]}\|null, fov?: 30-110, hideHud?, hideHand?, hidePlayer?, reset?}` | returns the resulting `{mode, fixed, fov, hideHud, hideHand, hidePlayer, pos}` |
| POST | `/settings` | `{guiScale?, window?: {w, h}, time?: "freeze"\|"run", holdHud?, steadyPlayer?, itemName?, toasts?, textCursor?}` | persistent until changed (until the client stops). Returns `{window, guiScale, guiWidth, guiHeight, holdHud, steadyPlayer, itemName, toasts, textCursor}`. |
| POST | `/resourcepack` | `{path, timeoutMs?: 120000}` or `{clear: true}` | applies one local resource pack above all others and returns when the resource reload has finished. Returns `{pack, source, compatible, reloaded, ms, selected: [pack ids]}`. |

`/camera`: `fixed` detaches the camera to an exact pose (`at` computes yaw and pitch towards a point) and, when the
camera was in first person and no `mode` is given, switches to `back` so the player is drawn. `fixed: null` attaches
it again. `hideHud` is the vanilla F1 state and also hides the first-person hand. `hidePlayer` hides the own player
in third person. `reset: true` restores first person, the original fov and all flags, then applies the other keys.

`/settings`:

- `guiScale`: forced exactly, also beyond what vanilla allows for the window (vanilla keeps 320x240 GUI pixels, so
  at 1280x720 it stops at 3). GUI space is window / guiScale; a tall tooltip at scale 4 needs a taller window.
  `0` returns to the options.txt value.
- `window`: resizes the window and with it the framebuffer (320x240 to 7680x4320).
- `time`: `freeze` sends `/tick freeze`, `run` sends `/tick unfreeze` (needs permission on a server).
- `holdHud`: keeps the action bar and the title at full opacity instead of letting them time out, and the closed-chat lines from expiring. Turn it off to
  let them fade; `/disconnect` turns it off.
- `steadyPlayer` (default true): no idle arm sway on the own player model. `itemName` (default false): the held
  item name popup above the hotbar. Both defaults exist for reproducible shots.
- `toasts` (default false): toasts (advancement, recipe, tutorial, "Chat messages can't be verified") are dropped
  when they are raised and none is drawn. `true` shows the ones raised from then on.
- `textCursor` (default false): the cursor of text inputs and signs, which vanilla blinks with wall-clock time, is
  not drawn. `true` draws it steadily.

`/resourcepack`: `path` is a pack directory (with `pack.mcmeta`) or a `.zip`. The mod copies it to
`<game dir>/resourcepacks/agent-lens-local[.zip]`, selects it on top and reloads (about 3 s). The same path with
unchanged content (file count, total size, newest modification time) is not reloaded again (`reloaded: false`), so
the call is cheap to repeat. `clear` (or `enable: false`) deselects it, reloads and deletes the copy. The selection
is not written to options.txt: after a client restart the pack is off until the next call. A pack the game cannot
load is dropped by the game and the answer is 500. A server pack sent later still goes on top of it. Use it for
servers that send no pack of their own (custom font glyphs would render as boxes).

## Reading (data, not pixels)

| Method | Path | Result |
|---|---|---|
| GET | `/screen` | `{guiScale, guiWidth, guiHeight, class, title, titleJson, rect, widgets: [{label, type, rect, active}], slots?: [{index, rect, item}], carried?}`; `class: null` when no screen is open. `item` is `{id, count, name, lore: [..], tooltip: [..]}` or null, all plain text; `tooltip` is every tooltip line. `titleJson` is the title as a text component (fonts and colours a plain string loses; a title can be a single private-use character that a server pack maps to a GUI texture). In a creative inventory the slot indices are those of the creative menu, not of the survival inventory: read them here. Works for server dialogs (`net.minecraft.client.gui.screens.dialog.*`) like for any other screen. |
| GET | `/hud` | `{hidden, chat: {lines}, actionbar: {text, ticksLeft}, title: {title, subtitle, ticksLeft}, bossbar: {bars: [{name, progress, color}]}, sidebar: {title, lines: [{name, score}]}, hotbar: {selected}}`; each part also has `visible` (drawn in the last frame) and `rect` (where it was last drawn, or null). `POST /hud {"lines": N}` selects how many chat lines (default 20). |
| GET | `/regions` | all region rects of the last frame: `{full: rect, screen: rect, tooltip: rect, ...}` |

## Capture

`POST /capture`

```json
{
  "region": "full",
  "pad": 8,
  "guiScale": 4,
  "hover": {"slot": 13},
  "out": "/abs/path/shot.png",
  "settleFrames": 2,
  "chat": false
}
```

- `out`: absolute path of the PNG; parent directories are created.
- `region` (default `full`):
  - `full`: the whole frame.
  - `screen`: what the open screen drew, measured (without its tooltip and without window-covering backdrops); for
    container screens united with the container panel, so creative tabs and the recipe book are included.
  - `slot:<n>`, `slots:<a>-<b>`: slot rects of a container screen (indices as in `/screen`).
  - `widget:<label>`: a widget of the open screen; exact label, else case-insensitive, else substring.
  - `tooltip`: where the tooltip was drawn in this frame. `screen+tooltip`: union.
  - HUD: `chat`, `actionbar`, `title` (with subtitle), `sidebar`, `bossbar`, `hotbar`, plus `status` (hotbar with
    hearts, food, experience), `tablist`, `effects`, `crosshair`.
  - `{x, y, w, h}` in framebuffer pixels.
  - An array of regions gives their union.
- Measured regions (`screen`, `tooltip`, HUD) are the bounding box of the GUI elements the game submitted for that
  part in exactly the captured frame, recorded by mixins, not estimated.
- `pad`: framebuffer pixels around the region (default 0), clamped to the frame.
- `guiScale`: applied for this shot only (the sharp way to enlarge GUI evidence), then restored. GUI space is
  window / guiScale: what does not fit is cut off at the frame edge (at 1280x720 and scale 4 a creative inventory or
  a tall tooltip). Enlarge the window first (`/settings window`).
- `chat`: whether the chat lines are drawn in this shot. Default: true when the region is `full`, `chat`, a pixel
  rect or an array containing one of them, false otherwise. Chat lines overlap the action bar and show through
  behind a screen, and they differ between runs (command feedback), so a crop of another part leaves them out. The
  chat screen itself (chat open for typing) is never affected.
- A region list that names `chat` is a chat shot: closed-chat lines are drawn as at the arrival of the newest one
  (no 10 s expiry), and the HUD sections not named in the list (action bar, title, item name, crosshair, sidebar,
  tab list, boss bar, effects) are not drawn, so nothing covers the lines. With the chat screen open, `chat` is
  the screen's region: lines, input field, suggestions.
- PNG files are encoded in memory at the highest deflate level, as a palette image when the shot has at most 256
  colours (whichever is smaller), and written once. Forges store uploads unchanged, so this is the size they keep.
- `hover`: same as `/hover`, applied for this shot only, then restored.
- `settleFrames` (default 2): frames rendered with the shot state before the captured one.
- The frame is read from the main render target after a finished frame through the game's own readback, so it works
  on the OpenGL and the Vulkan backend.
- Result: `{file, width, height, rect, regions: {<name>: rect, ...}, guiScale}`.
- A region that is not on screen is a 404 naming the regions that are.

`POST /frames`: `{region, count?: 8, intervalTicks?: 2, out, format?: "sheet"\|"gif"\|"png-sequence", columns?,
delayMs?, pad?, guiScale?, hover?, settleFrames?, chat?}` for particles and animations. The first frame fixes the
crop for all frames. Frames are taken at exact client tick offsets (`intervalTicks: 0` = consecutive frames).

- `sheet`: one PNG with the frames in a grid (`columns`, default ceil(sqrt(count))). Result adds `{file, width,
  height, columns, rows}`.
- `gif`: looping GIF, `delayMs` per frame (default intervalTicks * 50). Result adds `{file, width, height, delayMs}`.
- `png-sequence`: `out` ending in `.png` gives `name-000.png`, `name-001.png`, ...; otherwise `out` is a directory
  and the files are `frame-000.png`, ... Result adds `{files: [...]}`.
- Always in the result: `{format, count, rect, ticks: [offsets]}`.

`POST /compose`: `{before: file, after: file, out, labels?: ["Vorher", "Nachher"], layout?: "row"\|"column",
scale?: 1}` writes one PNG with both images under a label bar each. `scale` is an integer, nearest neighbour. Images
of different size are centred in equal cells. Labels are drawn with the game's 8 px bitmap font (the headless JDK
has no usable Java2D fonts), ASCII only: umlauts are written as ae/oe/ue/ss, other characters as `?`. Result:
`{file, width, height, cells: [rect, rect], identical}` (`identical`: both inputs have the same pixels). Needs no
world.

`POST /record`: `{action: "start", out: "<file>.wav", video?: region | true, intervalTicks?: 2, pad?}` starts
recording the game's sound output, `{action: "stop"}` ends it. One recording at a time (409 otherwise).

- Result of `stop`: `{file, image, ticks, durationMs, sampleRate, channels, peakDb, rmsDb, silent, firstSoundMs?,
  lastSoundMs?, onsets: [{ms, db}], sounds: [{ms, tick, id, file, source, volume, pitch, pos | relative}]}`, with
  `video` also `frames: {dir, count, intervalTicks, rect, ms: [...], error?}` (PNG files `frame-0000.png`, ... and
  the time of each in the recording; the CLI turns them into an MP4 and removes the directory).
- `image` is the waveform picture `<file>.png`. Levels are dBFS; an onset is a rise of at least 10 dB above -45 dB.
- How it works: the client runs OpenAL Soft on its wave-writer backend (`ALSOFT_DRIVERS=wave`), whose output file
  is a symlink to `/dev/null`. `start` points the link at a real file and reopens the device, `stop` points it
  back; all times are read from the device's sample clock (`ALC_SOFT_device_clock`), one mixer period is 5.3 ms.
  With `ALSOFT_DRIVERS=null` in the config `env`, `record` answers 409.
- While a recording runs the client keeps its full frame rate and does not idle out; after 120 s without `stop`
  it is discarded.

## Reproducible shots

The picture is vanilla: default menu background blur (pause menu, dialogs; container screens only dim the world,
as in the game) and vignette. Applied by the mod at start, in memory only, are just the options that move on their
own or with the tick phase: clouds off, view bobbing off, fov effects 0,
screen distortion 0, damage tilt 0, enchantment glint not scrolling, chunk fade-in 0, autosave indicator and
subtitles off. Also always: no heart blink after a health change (it depends on the tick phase), no toasts, no text
cursor, no held item name popup, no idle arm sway (the last four are `/settings`), chat lines left out of crops
(`chat` of `/capture`), and `ready` waits for the first-person hand.

Together with `/singleplayer`'s world rules, the same scene captured twice gives byte-identical PNGs for
inventories, tooltips, dialogs with text inputs, HUD parts and third-person frames. Checked for a fresh world against
the same world reopened, and across a client restart.

Still different between runs:

- `full` (or `chat`) when the chat lines differ. Command feedback often does: `/clear` answers differently on an
  empty inventory. `/chat {"clear": true}` before the shot, or `"chat": false`.
- Particles (random) and animated textures.
- Block animations behind a screen: a chest lid is still opening when the chest screen appears and shows in the
  padding around the panel. `/wait {"for": "ticks", "ticks": 20}` before the shot makes it identical.
- Hunger and heart jitter at low food or health, and anything else driven by wall-clock time.
- World state a scene leaves behind (inventory, game mode, blocks): the second run starts from it. Reset it in the
  scene (`/clear`, `/setblock`) before the first capture.

The first-person hand is drawn by vanilla with a fixed 70 degree field of view, independent of `/camera fov`: a
held sword reaches up to about a third of the frame height from the top at 16:9. That is the vanilla size. Where it
distracts, use `/camera {"hideHand": true}`.
