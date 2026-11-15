// web: real browser screenshots, measurements, ARIA snapshots and before/after composites (Playwright in Docker).
import { loadConfig } from '../core/config.mjs';
import { APP } from '../core/paths.mjs';
import { compare } from './compare.mjs';
import { PLAYWRIGHT_VERSION } from './docker.mjs';
import { runPages } from './shot.mjs';
import { UsageError } from './spec.mjs';

const HELP = `${APP} web: real browser screenshots and page checks (Playwright ${PLAYWRIGHT_VERSION}, Docker)

  ${APP} web shot     [--spec file.json] [flags] --out <dir>     PNGs + manifest.json
  ${APP} web measure  [--spec file.json] [flags]                 JSON of boxes and computed styles, no images
  ${APP} web snapshot [--spec file.json] [flags]                 ARIA tree as text, console and page errors,
                                                                    failed requests; no image
  ${APP} web compare  --before <dir> --after <dir> --out <dir>   side-by-side composites + pixel diff numbers

shot / measure / snapshot flags (each overrides the same field of the spec, for every shot):
  --url <url> | --base-url <url> --path </p>    page to load
  --serve <dir>[:port] [--spa]                  serve a static dir on 127.0.0.1 for this run and use it as base URL
  --name <name>                                 file name stem (default: derived from the path)
  --viewport mobile,tablet,desktop,WxH          default desktop (mobile 375x812, tablet 768x1024, desktop 1440x900)
  --scale 1,2            --scheme light,dark    device scale factors, color schemes
  --browser chromium,webkit,firefox             default chromium; the file name carries any other browser
  --selector <sel>       --padding <px>         section shot: element box plus padding, clamped to the page
  --target full|viewport --clip x,y,w,h         whole page (default), visible viewport, or a page rectangle
  --action <type:arg>    (repeatable)           click: hover: focus: press: scrollTo: waitFor: wait:<ms> eval:<js>
                                                fill:<sel>=><text>, or a JSON object as in the spec
  --mask <sel>           (repeatable)           cover dynamic content with a solid box
  --measure <sel>        (repeatable)           extra selectors to measure into the manifest
  --style prop,prop                             computed styles to record for measured elements
  --header 'Name: value' --cookie name=value --local-storage key=value   (repeatable) auth and state
  --locale de-DE --timezone Europe/Berlin --date 2026-01-01T12:00:00Z    fixed environment
  --wait-until load|domcontentloaded|commit --idle-timeout <ms> --timeout <ms>
  --animations disabled|allow   --mobile   --allow-http-errors
  --fail-on-console-error                       a console error or uncaught exception fails the shot
  --only name,name       run only these shots of the spec
  --jobs <n>             parallel pages (default 4)
  --json                 print the manifest instead of the summary lines

snapshot flags:
  --selector <sel>       snapshot of this element instead of the page body
  --depth <n>            drop nodes nested deeper than n   --max-chars <n> (default 6000)

compare flags:
  --labels Vorher,Nachher   --layout row|column   --threshold <0-255 per channel>
  --highlight (outline the changed area)   --diff (also write <name>.diff.png)   --only name,name   --json

common: --dns <ip> (repeatable, container DNS)  --max-time <s> (default 600)  --keep-job
Reference with examples: docs/usage-web.md
`;

export async function runWeb(argv) {
  const [sub, ...rest] = argv;
  let code;
  try {
    if (!sub || sub === 'help' || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
      console.log(HELP);
      code = 0;
    } else if (['shot', 'measure', 'snapshot'].includes(sub)) code = await runPages(loadConfig(), sub, rest);
    else if (sub === 'compare') code = await compare(loadConfig(), rest);
    else throw new UsageError(`unknown command "web ${sub}" (shot, measure, snapshot, compare, help)`);
  } catch (e) {
    console.error(`${APP} web: ${e.message}`);
    code = e instanceof UsageError ? 2 : 1;
  }
  process.exitCode = code;
  return code;
}
