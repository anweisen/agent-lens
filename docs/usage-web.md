# agent-lens web

Real browser screenshots of pages and page sections (Chromium, WebKit, Firefox), for checking a change while
developing and for before/after evidence in pull requests. Written for an agent: every command is one shot, prints
one line per result, and exits non-zero when something is wrong.

- `agent-lens web snapshot`: the page as text (ARIA tree) plus console errors, page errors and failed requests.
  No image. The cheap "does it render as intended" check.
- `agent-lens web measure`: boxes and computed styles as JSON on stdout, no image.
- `agent-lens web shot`: PNGs plus `manifest.json` (measured boxes, page size, errors).
- `agent-lens web compare`: side-by-side before/after composites and pixel diff numbers.

## How it runs

The browser runs in `docker run --rm` (image `mcr.microsoft.com/playwright:v<version>-noble`, which ships all
three browsers), one container per command, gone when the command returns. Nothing stays running. The version is
pinned once, in `web/package.json` (`dependencies.playwright`); the image tag is derived from it.

- First use installs `playwright` into `~/.cache/agent-lens/web/pw` (a few seconds) and pulls the image.
- The container shares this machine's network (`--net=host`): `http://127.0.0.1:<port>` is your dev server.
- The docker CLI is used as your shell has it set up. A remote daemon or a context goes into the config
  (`web.docker.env`, `web.docker.args`), see [config.md](config.md).
- **Files.** The job goes to the container on stdin and the result comes back on stdout; no temporary files.
  Results are written once, straight into `--out`, which is bind-mounted when the Docker daemon can see it (below
  the home directory, or below `web.mountRoot`). Only a directory the daemon cannot see (`/tmp` on a remote
  daemon, for example) is staged through `~/.cache/agent-lens/web/jobs` and copied; the staging directory is
  removed on every exit path, including Ctrl-C.
- Exit codes: `0` ok, `1` a shot or pair failed (selector matched nothing, HTTP error, timeout), `2` usage error.

## Checking a change while developing

Three steps, cheapest first. None needs a spec file.

```sh
# 1. Does it render, and is the console clean? Text only, about 2 s.
agent-lens web snapshot --url http://127.0.0.1:3000/settings
#   == settings desktop  http://127.0.0.1:3000/settings  status 200
#   - main:
#     - heading "Settings" [level=1]
#     - textbox "Display name"
#     - button "Save"
#   page errors: 0
#   console errors: 1
#     Failed to load resource: the server responded with a status of 404 (Not Found)  (http://127.0.0.1:3000/a.png)
#   failed requests: 1
#     GET http://127.0.0.1:3000/a.png: HTTP 404

# 2. Is the layout what you meant? Numbers, no image.
agent-lens web measure --url http://127.0.0.1:3000/settings --selector '.form-row' --style gap,padding \
  --viewport mobile

# 3. One look at the result.
agent-lens web shot --url http://127.0.0.1:3000/settings --selector 'main' --viewport mobile --out /tmp/look
```

`snapshot` takes the same page flags as `shot` (`--url`, `--serve`, `--action`, `--viewport`, `--browser`,
`--cookie`, a `--spec`, ...), so a state behind a click is `--action click:text=Open`. `--selector` limits the tree
to one element, `--depth n` drops nodes nested deeper than `n`, `--max-chars n` (default 6000) cuts long output
and says how much is missing. `--fail-on-console-error` turns a console error or an uncaught exception into exit
code 1. `--json` prints everything as JSON.

This is for looking at a change. Regression tests that should keep running belong in the project's own
[Playwright Test](https://playwright.dev/docs/intro) suite (`expect(page).toHaveScreenshot()`,
`toMatchAriaSnapshot()`), not here.

## Quick examples

```sh
# Whole page of a running dev server, phone and desktop, light and dark
agent-lens web shot --url http://127.0.0.1:3000/pricing --viewport mobile,desktop --scheme light,dark --out shots/before

# One section with 16px of context around it, retina
agent-lens web shot --base-url http://127.0.0.1:3000 --path /pricing --name plans \
  --selector '.plans' --padding 16 --scale 2 --out shots/before

# A hover state: the menu is the target, hovering the button opens it
agent-lens web shot --url http://127.0.0.1:3000/ --name menu --selector '.menu-items' --padding 16 \
  --action 'hover:.menu-button' --out shots/before

# A static build without a server: served on a free loopback port for the duration of the run
agent-lens web shot --serve dist --path /index.html --out shots/before
agent-lens web shot --serve dist:4173 --spa --path /settings/profile --out shots/before

# Numbers only
agent-lens web measure --url http://127.0.0.1:3000/ --selector '.card' --style padding,font-size --viewport mobile
```

## Output

File names: `<name>.<viewport>[.<browser>][@<scale>x][.dark].png`, for example `plans.mobile.png`,
`plans.desktop@2x.dark.png`, `home.desktop.firefox.png`, `home.1280x720.png` (Chromium is not
named). `<name>` defaults to the URL path (`/` becomes `index`, `/a/b`
becomes `a-b`).

Summary on stdout, one line per shot:

```
ok   cards.mobile.png  375x628px  section  box 0,269 375x596  clip 0,253 375x628  page 375x1765
ok   home.desktop.png  1440x1385px  full  page 1440x1385
FAIL index.desktop.png  selector ".nope" matched nothing
13 shots, 0 failed -> /abs/path/shots/before/manifest.json
```

`manifest.json` has one entry per shot. Use it to check layout by numbers. All boxes are CSS pixels in **page
coordinates** (`getBoundingClientRect()` plus scroll offset), so they do not depend on the scroll position.

| Field | Meaning |
|---|---|
| `name`, `file`, `url` | shot name, PNG file, loaded URL |
| `viewport` `{name,width,height}`, `scale`, `scheme`, `browser` | settings of this variant (`browser` only when it is not Chromium) |
| `target` | `full`, `viewport`, `section` or `clip` |
| `selector`, `matches` | section selector and how many elements matched (the first is used) |
| `box` | measured box of the section element |
| `clip` | captured rectangle: box plus padding, clamped to the page, rounded outwards |
| `page` `{width,height}`, `scroll` `{x,y}` | document size and scroll position at capture time |
| `image` `{width,height}` | PNG size in device pixels (`clip` times `scale`) |
| `elements` | present with `measure`: per selector `{count, matches: [{tag, box, visible, text, styles}]}` |
| `styles` | present with `styles` on a section shot: computed styles of the section element |
| `status`, `networkIdle`, `ms` | HTTP status, whether the network went idle, time |
| `pageErrors`, `consoleErrors`, `failedRequests` | uncaught exceptions, `console.error` output, requests that failed or answered with HTTP 400 or more (subresources); each only when not empty. The summary line names the counts. |
| `error` | only on failure; the PNG is then absent (an older one of the same name is deleted) |

Running again into the same `--out` replaces entries with the same file name and keeps the others.

## Spec file

One JSON file describes a whole evidence set. Replay it against two builds by changing only the base URL.
Top-level fields are defaults for every shot. Precedence per field: **flag > shot > spec top level > built-in
default**. Without `shots`, the top level itself is the single shot.

```json
{
  "baseUrl": "http://127.0.0.1:3000",
  "viewports": ["mobile", "desktop"],
  "schemes": ["light", "dark"],
  "scales": [1],
  "locale": "de-DE",
  "timezone": "Europe/Berlin",
  "date": "2026-01-01T12:00:00Z",
  "mask": [".clock", "[data-testid=avatar]"],
  "cookies": [{ "name": "session", "value": "abc" }],
  "localStorage": { "theme": "system", "onboarding": { "done": true } },
  "headers": { "Authorization": "Bearer abc" },
  "setup": [{ "click": "text=Accept cookies" }],
  "shots": [
    { "name": "home", "path": "/" },
    { "name": "plans", "path": "/pricing", "selector": ".plans", "padding": 16,
      "measure": [".plan", ".plan h3"], "styles": ["font-size", "padding"] },
    { "name": "menu-open", "path": "/", "selector": ".menu-items", "padding": [72, 16, 16, 16],
      "actions": [{ "hover": ".menu-button" }] },
    { "name": "search", "path": "/", "target": "viewport", "viewports": ["desktop"], "scales": [2],
      "actions": [{ "fill": "input[type=search]", "value": "hello" }, { "press": "Enter" },
                  { "waitFor": ".results" }] },
    { "name": "banner", "path": "/", "clip": { "x": 0, "y": 0, "width": 1440, "height": 300 },
      "viewports": ["desktop"] }
  ]
}
```

| Field | Flag | Notes |
|---|---|---|
| `url`, or `baseUrl` + `path` | `--url`, `--base-url`, `--path` | `path` defaults to `/` |
| `name` | `--name` | file name stem; two shots must not produce the same file |
| `viewports` | `--viewport a,b` | `mobile` 375x812, `tablet` 768x1024, `desktop` 1440x900, or `WxH`. Default `desktop` |
| `scales` | `--scale 1,2` | device scale factor. Default 1 |
| `schemes` | `--scheme light,dark` | `prefers-color-scheme`. Default `light` |
| `browsers` | `--browser chromium,webkit,firefox` | one shot per browser. Default `chromium` |
| `target` | `--target`, `--full` | `full` (default) or `viewport`. A `selector` or `clip` takes precedence |
| `selector` | `--selector` | any Playwright selector: CSS, `text=Sign in`, `role=button[name="Save"]`, `.card >> nth=2` |
| `padding` | `--padding 16` or `8,16` | px around the box; number or `[top, right, bottom, left]` (CSS shorthand rules) |
| `clip` | `--clip x,y,w,h` | explicit rectangle in page coordinates |
| `setup`, `actions` | `--action` (repeatable) | run after load, `setup` (spec default list) first, then the shot's `actions` |
| `mask` | `--mask` (repeatable) | elements painted as a solid box (`maskColor`, `--mask-color`, default `#ff00ff`) |
| `measure`, `styles` | `--measure` (repeatable), `--style a,b` | extra selectors and computed style properties for the manifest |
| `headers`, `cookies`, `localStorage` | `--header 'K: v'`, `--cookie k=v`, `--local-storage k=v` | cookies default to the page origin; non-string localStorage values are JSON encoded |
| `locale`, `timezone`, `date` | `--locale`, `--timezone`, `--date` | `date` freezes `Date.now()` at that instant |
| `waitUntil`, `timeout`, `idleTimeout` | `--wait-until`, `--timeout`, `--idle-timeout` | `load` / 15000 ms (navigation and each action) / 5000 ms |
| `animations` | `--animations allow` | default `disabled` |
| `isMobile`, `userAgent`, `reducedMotion`, `allowHttpErrors` | `--mobile`, `--allow-http-errors` | mobile emulation (meta viewport, touch; not in Firefox); HTTP >= 400 fails the shot unless allowed |
| `failOnConsoleError` | `--fail-on-console-error` | a console error or uncaught exception fails the shot (no PNG) |
| `out` | `--out` | output directory |

The singular spellings `viewport`, `scale`, `scheme`, `browser` are accepted too. `--only name,name` runs a subset
of the shots.
`--jobs n` sets the number of parallel pages (default 4). `--json` prints the manifest instead of the summary.

### Actions

| Spec | `--action` | Does |
|---|---|---|
| `{ "click": "sel" }` | `click:sel` | click |
| `{ "hover": "sel" }` | `hover:sel` | move the mouse over it (stays there for the shot) |
| `{ "focus": "sel" }` | `focus:sel` | focus |
| `{ "fill": "sel", "value": "text" }` | `fill:sel=>text` | set an input's value |
| `{ "press": "Enter" }` (optional `"selector"`) | `press:Enter` | key press, e.g. `Tab`, `Escape`, `Control+k` |
| `{ "scrollTo": "sel" }`, `{ "scrollTo": 800 }`, `{ "scrollTo": { "x": 0, "y": 800 } }` | `scrollTo:sel`, `scrollTo:800` | scroll an element into view or to a position |
| `{ "waitFor": "sel" }` (optional `"state"`: `visible`, `attached`, `hidden`, `detached`) | `waitFor:sel` | wait for an element |
| `{ "wait": 300 }` | `wait:300` | fixed delay in ms (last resort) |
| `{ "eval": "document.querySelector('dialog').showModal()" }` | `eval:...` | run JS in the page |

Every action takes an optional `"timeout"` in ms. `--action` also accepts a JSON object. Selectors use the first
match.

## Determinism (what is done for you)

- A stylesheet is injected before the page's own scripts: `transition: none`, animation duration and delay 0 with
  one iteration (finite animations show their end state, infinite ones their unanimated base state), transparent
  caret, no smooth scrolling. `--animations allow` turns this off.
- Waits for `load`, `document.fonts.ready` and network idle. Network idle gives up after `idleTimeout`, so pages
  with streaming or polling requests still get shot (`networkIdle: false` in the manifest, "(network not idle)" in
  the summary).
- Each variant gets a fresh browser context: no state leaks between shots.
- `mask` paints the element in a solid colour inside the page (children hidden), so things stacked above it, like an
  open menu, stay visible. The element keeps its size: mask something whose size is stable.
- `date` fixes the clock. Timers still run.
- Section shots: the element is centred in the viewport before the actions run. If box plus padding fits the
  viewport it is captured from the viewport as rendered (sticky headers, hover states intact), otherwise from the
  full page.

Verified in Chromium: the same page shot twice gives byte-identical pixels (`compare` reports `same` for every
pair). Browsers differ from each other in text rendering and layout by a few pixels: compare like with like.

## measure

Same flags and spec as `shot`. `--selector` is repeatable here; with a spec, each shot's `selector` and `measure`
entries are measured. Prints JSON, optionally also written to `--out file.json`:

```sh
agent-lens web measure --spec evidence.json --base-url http://127.0.0.1:3001 --only plans --style gap,padding
```

```json
{ "measurements": [ { "name": "plans", "url": "...", "viewport": { "name": "mobile", "width": 375, "height": 812 },
    "scale": 1, "scheme": "light", "page": { "width": 375, "height": 1765 }, "scroll": { "x": 0, "y": 0 },
    "elements": { ".plan": { "count": 3, "matches": [
      { "tag": "article", "box": { "x": 24, "y": 269, "width": 327, "height": 79 }, "visible": true,
        "text": "Free ...", "styles": { "padding": "16px" } } ] } } } ] }
```

At most 50 matches per selector are listed; `count` is the real number. A selector that matches nothing is an error.

## compare

```sh
agent-lens web compare --before shots/before --after shots/after --out shots/compare
```

Pairs PNGs with the same file name in both directories and writes `<name>.<viewport>....compare.png` (both images
next to each other, labelled) plus `compare.json`.

```
changed  cards.desktop  76104 px (19.4301%)  bbox 0,16 1440x256  size 1440x248 -> 1440x272  -> cards.desktop.compare.png
same     home.mobile  0 px  -> home.mobile.compare.png
only-before  old-page.desktop.png
13 pairs, 12 changed, 0 failed -> /abs/path/shots/compare/compare.json
```

- `--labels Before,After` replaces the default labels "Vorher,Nachher" (German for before, after).
- `--layout column` stacks the images (better for wide desktop shots); default `row`.
- `--threshold n` ignores per-channel differences up to `n` (0 to 255, default 0: exact).
- `--highlight` outlines the changed area in red on both images. `--diff` also writes `<name>.diff.png` (changed
  pixels in magenta on a faded copy of the after image).
- `--only home,plans` limits by shot name or file stem. `--json` prints `compare.json` to stdout.

`compare.json` per pair: `changedPixels`, `totalPixels`, `changedPercent`, `identical`, `bbox` (image pixels, of the
changed area), `before` / `after` sizes, `sizeChanged`, `file`. Pixels are counted in device pixels. Images of
different size are aligned at the top left and the area only one of them covers counts as changed, so a layout
shift above the fold makes everything below it "changed": compare section shots when you need a tight number.
Composites larger than 16384 px on a side are scaled down (`compositeScaledDown: true`); the diff numbers are
always computed at full resolution. Differences do not change the exit code.

## Before/after workflow with two worktrees

The base branch and the PR branch are checked out side by side, each served on its own port, and one spec is
replayed against both.

```sh
# 1. base branch in a second worktree
git worktree add ../myapp-base origin/main

# 2a. static builds: no server needed
(cd ../myapp-base && npm ci && npm run build)
npm run build
agent-lens web shot --spec evidence.json --serve ../myapp-base/dist:4101 --out evidence/before
agent-lens web shot --spec evidence.json --serve dist:4102 --out evidence/after

# 2b. or dev servers on two ports (start them in the background, stop them afterwards)
#     base: (cd ../myapp-base && npm run dev -- --port 4101)    branch: npm run dev -- --port 4102
agent-lens web shot --spec evidence.json --base-url http://127.0.0.1:4101 --out evidence/before
agent-lens web shot --spec evidence.json --base-url http://127.0.0.1:4102 --out evidence/after

# 3. composites and numbers
agent-lens web compare --before evidence/before --after evidence/after --out evidence/compare

# 4. clean up
git worktree remove ../myapp-base
```

Checks before the images go into a PR:

- Every line says `ok` and the exit code is 0. A `FAIL` means that PNG does not exist.
- `compare` says `changed` where the PR changes something and `same` for untouched shots. An unexpected `changed`
  is either a real regression or unmasked dynamic content (add it to `mask`, or set `date`).
- Read `box` / `elements` in both manifests for the claim you make ("gap is now 24px", "button no longer
  overflows"): numbers, not eyeballing.
- Open at least one composite and look at it.

## Troubleshooting

- `selector ... matched nothing`: the element is not there after the actions ran. Add a `waitFor`, or check the
  selector with `agent-lens web measure`.
- `matched an element that is not visible`: it exists but is 0x0 or hidden; the state (hover, click) is missing.
- `(network not idle)`: fine for streaming pages; lower `--idle-timeout` to save time.
- A page on a compose service name or the internet fails to resolve: add `--dns 1.1.1.1 --dns 8.8.8.8` (the
  default resolver is the machine's own and normally works).
- Hangs are bounded: `--max-time <s>` (default 600) kills the container from inside. Ctrl-C kills it too.
- `--keep-job` stages the run under `~/.cache/agent-lens/web/jobs` (job description and output) and keeps it for
  inspection.
- `the cache directory ... is not under a directory the Docker daemon can mount`: set `web.mountRoot`
  ([config.md](config.md)).
