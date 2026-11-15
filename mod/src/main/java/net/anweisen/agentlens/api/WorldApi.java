package net.anweisen.agentlens.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.net.InetAddress;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import net.anweisen.agentlens.capture.Regions;
import net.anweisen.agentlens.core.Lens;
import net.anweisen.agentlens.game.ChatLog;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.game.Readiness;
import net.anweisen.agentlens.game.Scene;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.http.Json;
import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.gamerules.GameRules;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.WorldDimensions;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;

final class WorldApi {

  private static final Pattern WORLD_NAME = Pattern.compile("[A-Za-z0-9_.-]{1,64}");

  /** Chat sequence number before the last /chat, so /wait chat sees the answers to it. */
  private static volatile long chatMark;

  private WorldApi() {
  }

  // ---- singleplayer --------------------------------------------------------------------------------------------

  static JsonElement singleplayer(JsonObject body) {
    String world = Json.require(body, "world");
    if (!WORLD_NAME.matcher(world).matches() || world.startsWith(".")) {
      throw ApiException.bad("world must match [A-Za-z0-9_.-]{1,64} and not start with a dot");
    }
    JsonObject create = Json.object(body, "create");
    boolean deterministic = Json.bool(body, "deterministic", true);
    long timeoutMs = Json.integer(body, "timeoutMs", 180_000);
    Minecraft minecraft = Minecraft.getInstance();

    String action = ClientThread.call(() -> {
      if (minecraft.level != null) {
        IntegratedServer server = minecraft.getSingleplayerServer();
        if (server != null && server.getWorldData().getLevelName().equals(world)) return "already";
        throw ApiException.conflict("already in a world or on a server, call /disconnect first");
      }
      return minecraft.getLevelSource().levelExists(world) ? "open" : "create";
    });
    if (action.equals("create") && create == null) {
      throw new ApiException(404, "world \"" + world + "\" does not exist, pass \"create\": {} to create it");
    }
    if (action.equals("create")) {
      boolean flat = Json.bool(create, "flat", true);
      boolean creative = Json.bool(create, "creative", true);
      long seed = seed(create);
      ClientThread.call(timeoutMs, () -> {
        LevelSettings settings = new LevelSettings(world, creative ? GameType.CREATIVE : GameType.SURVIVAL,
          new LevelSettings.DifficultySettings(Difficulty.PEACEFUL, false, false), true,
          WorldDataConfiguration.DEFAULT);
        Function<HolderLookup.Provider, WorldDimensions> dimensions = flat
          ? registries -> registries.lookupOrThrow(Registries.WORLD_PRESET).getOrThrow(WorldPresets.FLAT).value()
          .createWorldDimensions()
          : WorldPresets::createNormalWorldDimensions;
        minecraft.createWorldOpenFlows().createFreshLevel(world, settings, new WorldOptions(seed, false, false),
          dimensions, new TitleScreen());
        return null;
      });
    } else if (action.equals("open")) {
      ClientThread.call(timeoutMs, () -> {
        minecraft.createWorldOpenFlows().openWorld(world, () -> minecraft.gui.setScreen(new TitleScreen()));
        return null;
      });
    }
    Readiness.awaitReady(timeoutMs);
    if (deterministic) {
      calmWorld(minecraft, action.equals("create"));
      Readiness.awaitTicks(5);
      Readiness.awaitReady(timeoutMs);
    }
    JsonObject json = GameApi.status(new JsonObject()).getAsJsonObject();
    json.addProperty("created", action.equals("create"));
    return json;
  }

  private static long seed(JsonObject create) {
    if (!Json.has(create, "seed")) return 0;
    String text = create.get("seed").getAsString();
    try {
      return Long.parseLong(text);
    } catch (NumberFormatException notNumeric) {
      return text.hashCode();
    }
  }

  /** Fixed noon, clear weather, nothing spawning or growing. Runs on the integrated server thread. */
  private static void calmWorld(Minecraft minecraft, boolean created) {
    IntegratedServer server = ClientThread.call(minecraft::getSingleplayerServer);
    if (server == null) return;
    String player = ClientThread.call(() -> minecraft.player.getScoreboardName());
    CompletableFuture<Void> done = new CompletableFuture<>();
    server.execute(() -> {
      try {
        GameRules rules = server.getGameRules();
        rules.set(GameRules.ADVANCE_TIME, false, server);
        rules.set(GameRules.ADVANCE_WEATHER, false, server);
        rules.set(GameRules.SPAWN_MOBS, false, server);
        rules.set(GameRules.SPAWN_MONSTERS, false, server);
        rules.set(GameRules.SPAWN_PATROLS, false, server);
        rules.set(GameRules.SPAWN_PHANTOMS, false, server);
        rules.set(GameRules.SPAWN_WANDERING_TRADERS, false, server);
        rules.set(GameRules.RANDOM_TICK_SPEED, 0, server);
        rules.set(GameRules.SHOW_ADVANCEMENT_MESSAGES, false, server);
        rules.set(GameRules.LOCATOR_BAR, false, server);
        rules.set(GameRules.RESPAWN_RADIUS, 0, server);
        var source = server.createCommandSourceStack().withSuppressedOutput();
        server.getCommands().performPrefixedCommand(source, "time set 6000");
        server.getCommands().performPrefixedCommand(source, "weather clear");
        if (created) {
          int ground = server.overworld().getHeight(Heightmap.Types.MOTION_BLOCKING, 0, 0);
          server.getCommands().performPrefixedCommand(source, "kill @e[type=!player]");
          server.getCommands().performPrefixedCommand(source,
            "execute in minecraft:overworld run tp " + player + " 0.5 " + ground + " 0.5 0 0");
        }
        done.complete(null);
      } catch (Throwable error) {
        done.completeExceptionally(error);
      }
    });
    ClientThread.await(done, 30_000, "the world setup");
  }

  // ---- disconnect, connect -------------------------------------------------------------------------------------

  static JsonElement disconnect(JsonObject body) {
    Minecraft minecraft = Minecraft.getInstance();
    boolean wasInWorld = ClientThread.call(180_000, () -> {
      Screen screen = minecraft.gui.screen();
      if (minecraft.level == null) {
        // also leaves a "disconnected" or "connecting" screen behind
        if (!(screen instanceof TitleScreen)) minecraft.gui.setScreen(new TitleScreen());
        return false;
      }
      minecraft.disconnectFromWorld(ClientLevel.DEFAULT_QUIT_MESSAGE);
      if (!(minecraft.gui.screen() instanceof TitleScreen)) minecraft.gui.setScreen(new TitleScreen());
      return true;
    });
    ClientThread.run(() -> {
      Scene.hover = null;
      Scene.fixedCamera = null;
      Scene.hideHand = false;
      Scene.hidePlayer = false;
      Scene.holdHud = false;
      Regions.forget();
      var hud = minecraft.gui.hud;
      hud.clearTitles();
      Reflect.set(net.minecraft.client.gui.Hud.class, hud, "overlayMessageTime", 0);
    });
    ClientThread.awaitUntil(() -> minecraft.level == null && minecraft.gui.screen() instanceof TitleScreen, 60_000,
      "the title screen");
    ClientThread.awaitFrames(2);
    JsonObject json = GameApi.status(new JsonObject()).getAsJsonObject();
    json.addProperty("wasInWorld", wasInWorld);
    return json;
  }

  static JsonElement connect(JsonObject body) {
    String host = Json.require(body, "host").trim().toLowerCase(Locale.ROOT);
    if (!Json.has(body, "port")) throw ApiException.bad("\"port\" is required, there is no default port");
    int port = Json.integer(body, "port", -1);
    if (port < 1 || port > 65535) throw ApiException.bad("port must be 1-65535");
    String target = host + ":" + port;
    boolean allowed = Lens.allow().stream().anyMatch(entry -> entry.toLowerCase(Locale.ROOT).equals(target));
    if (!allowed) {
      throw new ApiException(403, "server " + target + " is not on the allowlist (-Dagentlens.allow), allowed: "
        + (Lens.allow().isEmpty() ? "none" : String.join(", ", Lens.allow())));
    }
    long timeoutMs = Json.integer(body, "timeoutMs", 90_000);
    Minecraft minecraft = Minecraft.getInstance();
    // port 25565 would make the client look for an SRV record; an address literal has none to find
    String connectHost = host;
    if (port == 25565) {
      try {
        connectHost = InetAddress.getByName(host).getHostAddress();
      } catch (java.net.UnknownHostException error) {
        throw new ApiException(502, "cannot resolve " + host);
      }
    }
    String finalHost = connectHost;
    ClientThread.run(() -> {
      if (minecraft.level != null) {
        throw ApiException.conflict("already in a world or on a server, call /disconnect first");
      }
      if (minecraft.gui.screen() instanceof ConnectScreen) throw ApiException.conflict("already connecting");
      ServerData data = new ServerData("agent-lens", target, ServerData.Type.OTHER);
      // no prompt: server resource packs are downloaded and applied right away
      data.setResourcePackStatus(ServerData.ServerPackStatus.ENABLED);
      ConnectScreen.startConnecting(new TitleScreen(), minecraft, new ServerAddress(finalHost, port), data, false,
        null);
    });
    Readiness.awaitReady(timeoutMs);
    return GameApi.status(new JsonObject());
  }

  // ---- chat, wait ----------------------------------------------------------------------------------------------

  static JsonElement chat(JsonObject body) {
    if (Json.bool(body, "clear", false)) {
      ClientThread.run(() -> Minecraft.getInstance().gui.hud.getChat().clearMessages(false));
      ChatLog.clear();
      if (!Json.has(body, "text")) {
        ClientThread.awaitFrames(1);
        JsonObject cleared = new JsonObject();
        cleared.addProperty("cleared", true);
        return cleared;
      }
    }
    String text = Json.require(body, "text");
    if (text.isBlank()) throw ApiException.bad("text is empty");
    if (text.length() > 32_000) throw ApiException.bad("text is too long");
    int waitTicks = Math.clamp(Json.integer(body, "waitTicks", 3), 0, 200);
    Minecraft minecraft = Minecraft.getInstance();
    long mark = ClientThread.call(() -> {
      if (minecraft.getConnection() == null || minecraft.player == null) throw ApiException.conflict("not in a world");
      long before = ChatLog.seq();
      if (text.startsWith("/")) minecraft.getConnection().sendCommand(text.substring(1));
      else minecraft.getConnection().sendChat(text);
      return before;
    });
    chatMark = mark;
    Readiness.awaitTicks(waitTicks);
    ClientThread.awaitFrames(1);
    JsonObject json = new JsonObject();
    json.addProperty("sent", text);
    JsonArray replies = new JsonArray();
    for (ChatLog.Line line : ChatLog.since(mark)) replies.add(line.text());
    json.add("chat", replies);
    return json;
  }

  static JsonElement waitFor(JsonObject body) {
    String what = Json.require(body, "for");
    long timeoutMs = Json.integer(body, "timeoutMs", 30_000);
    String match = Json.string(body, "match", null);
    Minecraft minecraft = Minecraft.getInstance();
    long started = System.nanoTime();
    JsonObject json = new JsonObject();
    switch (what) {
      case "ready" -> Readiness.awaitReady(timeoutMs);
      case "screen" -> {
        String wanted = match == null ? null : match.toLowerCase(Locale.ROOT);
        ClientThread.awaitUntil(() -> {
          Screen screen = minecraft.gui.screen();
          if (screen == null || Readiness.isLoadingScreen(screen)) return false;
          return wanted == null || screen.getClass().getName().toLowerCase(Locale.ROOT).contains(wanted)
            || screen.getTitle().getString().toLowerCase(Locale.ROOT).contains(wanted);
        }, timeoutMs, match == null ? "a screen" : "a screen matching \"" + match + "\"");
        ClientThread.awaitFrames(2);
      }
      case "noscreen" -> {
        ClientThread.awaitUntil(() -> minecraft.gui.screen() == null, timeoutMs, "the screen to close");
        ClientThread.awaitFrames(2);
      }
      case "ticks" -> {
        int ticks = Json.integer(body, "ticks", 1);
        if (ticks < 0 || ticks > 12_000) throw ApiException.bad("ticks must be 0-12000");
        Readiness.awaitTicks(ticks);
        ClientThread.awaitFrames(1);
      }
      case "chat" -> {
        if (match == null) throw ApiException.bad("\"match\" is required for chat (regular expression)");
        Pattern pattern;
        try {
          pattern = Pattern.compile(match);
        } catch (PatternSyntaxException error) {
          throw ApiException.bad("match is not a valid regular expression: " + error.getDescription());
        }
        long mark = Json.bool(body, "fromNow", false) ? ChatLog.seq() : chatMark;
        String[] found = {null};
        ClientThread.awaitUntil(() -> {
          for (ChatLog.Line line : ChatLog.since(mark)) {
            if (pattern.matcher(line.text()).find()) {
              found[0] = line.text();
              return true;
            }
          }
          return false;
        }, timeoutMs, "a chat line matching /" + match + "/");
        json.addProperty("line", found[0]);
      }
      default -> throw ApiException.bad("for must be ready, screen, noscreen, chat or ticks");
    }
    json.addProperty("waitedMs", (System.nanoTime() - started) / 1_000_000);
    json.add("screen", ClientThread.call(() -> GameApi.screenJson(minecraft.gui.screen())));
    return json;
  }
}
