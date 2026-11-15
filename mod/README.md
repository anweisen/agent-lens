# lens mod

Fabric client mod (mod id `lens`) that exposes a loopback HTTP API for driving a real Minecraft client and taking
cropped screenshots of it. The API is described in [`docs/api.md`](../docs/api.md); this file is about the code.

Pinned: Minecraft 26.3, Java 25, Fabric Loader 0.20.1. No Fabric API, no Loom.

## Build

```sh
export JAVA_HOME=/path/to/jdk-25        # any JDK 25
./gradlew build                         # -> build/libs/lens-<version>.jar
```

26.x ships unobfuscated, so there is nothing to remap: the build is the plain Gradle `java` plugin and compiles
against the client jar and the libraries the launcher downloaded. Run `agent-lens mc install` once before the first
build. The cache directory is `${XDG_CACHE_HOME:-~/.cache}/agent-lens`, overridable with `-PagentLensCache=<dir>` or
`AGENT_LENS_CACHE`. There is no refmap and no mixin annotation processor.

## Install

```sh
./install.sh      # build, then replace lens*.jar in <cache>/game/mods and print the installed path
```

For another game directory copy `build/libs/lens-<version>.jar` into its `mods/` folder. The mod reads its settings
from system properties the launcher passes: `agentlens.port`, `agentlens.stateFile`, `agentlens.idleMinutes`,
`agentlens.idleFps`, `agentlens.busyFps`, `agentlens.allow`.

## Code map

Everything is under `src/main/java/net/anweisen/agentlens/`. Each package has a `package-info.java`.

| Package | What lives there | Classes |
|---|---|---|
| (root) | the Fabric entrypoint, nothing else | `LensMod` |
| `core` | startup, configuration, state file, request activity and idle shutdown | `Lens` |
| `http` | loopback HTTP server, routing, JSON helpers, error statuses; no game code | `ApiServer`, `ApiException`, `Json` |
| `api` | the endpoints, one class per group, and the route table | `Api`, `GameApi`, `WorldApi`, `ScreenApi`, `HudApi`, `PlayerApi`, `CaptureApi`, `FramesApi`, `RecordApi`, `ResourcePackApi` |
| `capture` | frame grab, measured regions, PNG/GIF/sheet/label image work | `Capture`, `Regions`, `Images`, `Gif`, `BitmapFont` |
| `audio` | sound recording through OpenAL Soft's wave writer, WAV files, level analysis and waveform picture | `Recorder`, `Wav`, `Analysis` |
| `game` | client-thread access and frame waits, readiness, screen geometry, scene overrides, mixin hooks | `ClientThread`, `Readiness`, `Screens`, `Scene`, `Hooks`, `ChatLog`, `Ticks`, `Determinism` |
| `util` | reflection on private game members, rectangle type | `Reflect`, `Rect` |
| `mixin` | the injections into the game | 14 mixins, see below |

How a request flows: `ApiServer` (HTTP thread) parses the body and calls the handler registered in `Api`. The
handler runs game code through `ClientThread.call/run` and waits for rendered frames with
`ClientThread.awaitFrames/awaitUntil`; those waits are evaluated at the end of every frame, which `MinecraftMixin`
reports to `Hooks.frameEnd`. A capture reads the frame back in exactly that frame-end callback (`Capture`), with the
regions `Regions` collected while the game submitted its GUI elements for that frame. Per-shot and persistent
overrides (GUI scale, virtual mouse, fixed camera, hidden parts) are plain fields in `Scene` that the mixins read.

## Version-fragile parts

A new Minecraft version breaks the mod in two places. Both fail loudly: a mixin that no longer applies stops the
client at start (`defaultRequire: 1`), a missing reflection name answers the request with
`field/method ... not found (game version changed?)`.

### Mixin targets (`mixin/`, registered in `src/main/resources/lens.mixins.json`)

| Mixin | Target | Purpose |
|---|---|---|
| `MinecraftMixin` | `Minecraft.renderFrame(Z)` TAIL | frame clock, capture point |
| `FramerateLimitTrackerMixin` | `FramerateLimitTracker.getFramerateLimit` HEAD | 10 fps idle, 60 fps around requests |
| `GuiMixin` | `Gui.extractRenderState` HEAD, RETURN | begin and publish the regions of a frame, place the virtual mouse |
| `GuiRenderStateMixin` | `GuiRenderState.findAppropriateNode(ScreenArea)` HEAD | bounds of every submitted GUI element |
| `GuiGraphicsExtractorMixin` | `GuiGraphicsExtractor.tooltip` HEAD, RETURN | `tooltip` region |
| `ScreenMixin` | `Screen.extractRenderStateWithTooltipAndSubtitles` HEAD, RETURN | `screen` region |
| `HudMixin` | `Hud.extractChat`, `extractOverlayMessage`, `extractTitle`, `extractScoreboardSidebar`, `extractBossOverlay`, `extractItemHotbar`, `extractHotbarAndDecorations`, `extractTabList`, `extractEffects`, `extractCrosshair` HEAD, RETURN; `extractPlayerHealth` HEAD; `tick()V` HEAD; shadows `overlayMessageTime`, `titleTime`, `titleFadeOutTime`, `titleStayTime`, `toolHighlightTimer`, `healthBlinkTime` | HUD regions (names mapped in `Hooks.hudSection`), no heart blink, `holdHud`, `itemName` |
| `ChatComponentMixin` | `ChatComponent.addMessage(Component, MessageSignature, GuiMessageSource, GuiMessageTag)` HEAD; the 7-argument `extractRenderState` HEAD | chat log, chat hidden for a shot |
| `ToastManagerMixin` | `ToastManager.addToast`, `extractRenderState` HEAD | toasts off |
| `TextCursorUtilsMixin` | `TextCursorUtils.isCursorVisible` HEAD | steady text cursor |
| `WindowMixin` | `Window.calculateScale(IZ)` HEAD | exact forced GUI scale |
| `GameRendererMixin` | `GameRenderer.renderItemInHand` HEAD | `hideHand` |
| `CameraMixin` | `Camera.alignWithEntity(F)` TAIL; shadows `detached`, `setRotation`, `setPosition` | fixed camera, `hidePlayer` |
| `EntityRendererMixin` | `EntityRenderer.extractRenderState(Entity, EntityRenderState, F)` TAIL | no idle arm sway on the own player |

An `@Inject` handler takes all arguments of its target or none; a prefix does not apply.

### Reflection names (all through `util/Reflect`, Mojang names)

| Where | Private members |
|---|---|
| `game/Ticks` | `Minecraft.clientTickCount` |
| `game/Hooks`, `api/ScreenApi` | `MouseHandler.xpos`, `ypos`, `lastClick` |
| `game/Screens` | `AbstractContainerScreen.leftPos`, `topPos`, `imageWidth`, `imageHeight` |
| `game/Readiness` | `FirstPersonHandsAndItems.mainHandHeight`, `oMainHandHeight`, `offHandHeight`, `oOffHandHeight`; `DownloadedPackSource.manager`, `ServerPackManager.packs` and per pack `promptAccepted`, `removalReason`, `activationStatus` (value `ACTIVE`); `DisconnectedScreen.details`; `ConfirmScreen.yesButton` |
| `api/HudApi`, `api/WorldApi` | `Hud.overlayMessageString`, `overlayMessageTime`, `title`, `subtitle`, `titleTime`; `BossHealthOverlay.events` |
| `api/PlayerApi` | `Minecraft.startUseItem()`, `startAttack()`, `missTime`, `rightClickDelay` |
| `audio/Recorder` | `SoundManager.soundEngine`; `SoundEngine.loaded`, `library`; `Library.currentDevice` |

Names matched as strings rather than types: the loading screens in `game/Readiness` (`LevelLoadingScreen`,
`GenericMessageScreen`, `ReceivingLevelScreen`, `ConnectScreen`, `ProgressScreen`, `ServerReconfigScreen`), the
private `PackConfirmScreen`, and the font sheet `/assets/minecraft/textures/font/ascii.png` in `capture/BitmapFont`.
