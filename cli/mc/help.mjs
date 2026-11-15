import { APP, ENV_PREFIX } from '../core/paths.mjs';

export const MC_USAGE = `usage: ${APP} mc <command>

The client starts by itself on the first API command and exits after 10 idle minutes.

lifecycle
  status [--json]           process (pid, memory, session) and, when the API is up, game state; exit 1 and
                            "not running" when there is no client (stale state files are removed)
  start [--wait] [--auth offline|microsoft] [--restart] [--backend opengl|vulkan] [--width N] [--height N]
        [--username NAME] [--env KEY=VALUE] [--jvm-arg=ARG]
  stop                      stop the client now (whole process group)
  quit                      ask the client to shut down cleanly
  logs [-n N] [--full]      tail of the client log
  install [--verify]        download client, libraries, assets, Fabric loader (idempotent)
  command [--auth MODE]     print the java command line (token redacted), start nothing
  login                     interactive Microsoft device code login into the token cache

world
  singleplayer <world> [--create] [--create-flat] [--create-creative] [--create-seed N]
  connect <server> [--restart] [--force]     configured name or its exact host:port, nothing else
  disconnect                leaves the world or server (a local world is saved)
  wait ready|screen|noscreen|chat|ticks [match] [--ticks N] [--timeout-ms N] [--from-now]
                            chat: match is a regular expression; screen: part of the class name or title
  resourcepack <dir|zip> | --clear     local resource pack on top of everything, returns after the reload

act
  chat <text...> [--wait-ticks N] | --clear    message, or command with a leading /; prints the feedback lines
  key <key> [tap|down|up] [--shift] [--ctrl]
  type <text...> [--widget LABEL] [--clear]    text into the focused (or named, or first) text input, sign, book
  click  --slot N | --x N --y N | --widget LABEL  [--button left|right|middle] [--shift] [--ctrl] [--double]
  hover  --slot N | --x N --y N | --widget LABEL | --none      x, y are GUI coordinates (pixels / guiScale)
  use [item|block|entity]      attack [item|block|entity]
  hotbar <0-8>
  look --yaw N --pitch N | --at x,y,z
  camera [first|back|front] [--fixed-pos x,y,z --fixed-yaw N --fixed-pitch N | --fixed-at x,y,z] [--fov N]
         [--hide-hud] [--hide-hand] [--hide-player] | --reset
  settings [--gui-scale N] [--window-w N --window-h N] [--time freeze|run] [--hold-hud] [--toasts]
           [--text-cursor] [--item-name] [--steady-player false]

read (data, not pixels)
  screen    hud [--lines N]    regions

capture
  capture <region...> --out FILE [--pad N] [--gui-scale N] [--hover-slot N | --hover-widget L]
          [--settle-frames N] [--chat true|false]
          regions: full screen slot:N slots:A-B tooltip screen+tooltip chat actionbar title sidebar bossbar
          hotbar status tablist effects crosshair widget:LABEL or '{"x":..,"y":..,"w":..,"h":..}'; several
          regions give their union. Chat lines are left out unless the region is full, chat or a pixel rect.
  frames <region> --count N --interval-ticks N --out FILE --format gif|sheet|png-sequence [--columns N]
  compose --before FILE --after FILE --out FILE [--labels Vorher,Nachher] [--layout row|column] [--scale N]
  record start --out FILE.wav [--video [REGION]] [--interval-ticks N]    sound (and frames) from now on
  record stop       FILE.wav + waveform FILE.png (+ FILE.mp4 with ffmpeg); prints onsets and the sounds played

scenes
  scene run <scene.json> --out <dir> [--server NAME] [--keep-going] [--restart] [--force]
  scene compare --before <dir> --after <dir> --out <dir> [--labels A,B] [--layout L] [--scale N] [--pixel-diff]

escape hatch
  api <METHOD> </path> [json | @file | key=value ...]

Flags are the API fields in kebab case (--gui-scale -> guiScale, --hover-slot -> hover.slot); unknown flags are
passed through and take the next argument as their value (known switches such as --clear or --shift do not).
Every API command takes --json (raw answer) and --no-start (fail instead of starting the client).
${ENV_PREFIX}_STATE_DIR and ${ENV_PREFIX}_GAME_DIR select a second, independent client instance.
`;
