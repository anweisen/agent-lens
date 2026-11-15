package net.anweisen.agentlens.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.anweisen.agentlens.core.Lens;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.game.Readiness;
import net.anweisen.agentlens.game.Scene;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.http.Json;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.player.LocalPlayer;

final class GameApi {

  private GameApi() {
  }

  static JsonElement status(JsonObject body) {
    JsonObject json = ClientThread.call(() -> {
      Minecraft minecraft = Minecraft.getInstance();
      JsonObject status = new JsonObject();
      status.addProperty("state", Readiness.state(minecraft));
      ServerData server = minecraft.getCurrentServer();
      status.addProperty("server", server == null ? null : server.ip);
      status.addProperty("world", minecraft.hasSingleplayerServer()
        ? minecraft.getSingleplayerServer().getWorldData().getLevelName() : null);
      status.add("screen", screenJson(minecraft.gui.screen()));
      LocalPlayer player = minecraft.player;
      if (player == null || minecraft.level == null) {
        status.add("player", null);
      } else {
        JsonObject playerJson = new JsonObject();
        playerJson.addProperty("name", player.getName().getString());
        playerJson.add("pos", Json.array(player.getX(), player.getY(), player.getZ()));
        playerJson.addProperty("yaw", player.getYRot());
        playerJson.addProperty("pitch", player.getXRot());
        playerJson.addProperty("dimension", minecraft.level.dimension().identifier().toString());
        status.add("player", playerJson);
      }
      var window = minecraft.getWindow();
      JsonObject windowJson = new JsonObject();
      windowJson.addProperty("w", window.getWidth());
      windowJson.addProperty("h", window.getHeight());
      windowJson.addProperty("guiScale", window.getGuiScale());
      status.add("window", windowJson);
      var device = com.mojang.blaze3d.systems.RenderSystem.getDevice().getDeviceInfo();
      status.addProperty("backend", device.backendName());
      status.addProperty("renderer", device.name());
      status.addProperty("fps", minecraft.getFps());
      status.addProperty("camera", minecraft.options.getCameraType().name().toLowerCase(java.util.Locale.ROOT));
      return status;
    });
    json.addProperty("idleSecondsLeft", Lens.idleSecondsLeft());
    json.addProperty("version", Lens.version());
    return json;
  }

  static JsonElement screenJson(Screen screen) {
    if (screen == null) return null;
    JsonObject json = new JsonObject();
    json.addProperty("class", screen.getClass().getName());
    json.addProperty("title", screen.getTitle().getString());
    return json;
  }

  static JsonElement quit(JsonObject body) {
    Lens.LOG.info("quit requested over the API");
    // answer first: stopping tears the server thread down with the client
    Thread stopper = new Thread(() -> {
      try {
        Thread.sleep(100);
      } catch (InterruptedException ignored) {
      }
      Lens.quit();
    }, "lens-quit");
    stopper.setDaemon(true);
    stopper.start();
    JsonObject json = new JsonObject();
    json.addProperty("stopping", true);
    return json;
  }

  static final int MAX_WINDOW_W = 7680;
  static final int MAX_WINDOW_H = 4320;

  /** API thread. Returns once the window and the main render target have the new size. */
  static void resizeWindow(int width, int height) {
    Minecraft minecraft = Minecraft.getInstance();
    ClientThread.run(() -> minecraft.getWindow().setWindowed(width, height));
    ClientThread.awaitUntil(() -> minecraft.getWindow().getWidth() == width
      && minecraft.getWindow().getHeight() == height
      && minecraft.gameRenderer.mainRenderTarget().width == width
      && minecraft.gameRenderer.mainRenderTarget().height == height, 10_000, "the window to resize");
  }

  static JsonElement settings(JsonObject body) {
    Minecraft minecraft = Minecraft.getInstance();
    if (Json.has(body, "guiScale")) {
      int scale = Json.integer(body, "guiScale", 0);
      if (scale < 0 || scale > 16) throw ApiException.bad("guiScale must be 1-16, or 0 for the options.txt value");
      ClientThread.run(() -> {
        Scene.forcedGuiScale = scale;
        minecraft.resizeGui();
      });
    }
    JsonObject size = Json.object(body, "window");
    if (size != null) {
      int width = Json.integer(size, "w", 0);
      int height = Json.integer(size, "h", 0);
      if (width < 320 || height < 240 || width > 7680 || height > 4320) {
        throw ApiException.bad("window needs w (320-7680) and h (240-4320)");
      }
      resizeWindow(width, height);
    }
    if (Json.has(body, "language")) {
      String code = Json.require(body, "language").toLowerCase(java.util.Locale.ROOT);
      boolean changed = ClientThread.call(() -> {
        var languages = minecraft.getLanguageManager();
        if (languages.getLanguage(code) == null) {
          throw ApiException.bad("unknown language \"" + code + "\": a language code such as en_us or de_de");
        }
        if (code.equals(languages.getSelected())) return false;
        languages.setSelected(code);
        minecraft.options.languageCode = code;
        return true;
      });
      if (changed) {
        // as the language screen does: reload the translations, then save, which also tells the server
        ResourcePackApi.reload(minecraft, null, 120_000);
        ClientThread.run(() -> minecraft.options.save());
        ClientThread.awaitFrames(2);
      }
    }
    if (Json.has(body, "holdHud")) Scene.holdHud = Json.bool(body, "holdHud", false);
    if (Json.has(body, "steadyPlayer")) Scene.steadyPlayer = Json.bool(body, "steadyPlayer", true);
    if (Json.has(body, "itemName")) Scene.itemName = Json.bool(body, "itemName", false);
    if (Json.has(body, "textCursor")) Scene.textCursor = Json.bool(body, "textCursor", false);
    if (Json.has(body, "toasts")) {
      Scene.toasts = Json.bool(body, "toasts", false);
      if (!Scene.toasts) ClientThread.run(() -> minecraft.gui.toastManager().clear());
    }
    if (Json.has(body, "time")) {
      String time = Json.string(body, "time", "");
      String command = switch (time) {
        case "freeze" -> "tick freeze";
        case "run" -> "tick unfreeze";
        default -> throw ApiException.bad("time must be \"freeze\" or \"run\"");
      };
      ClientThread.run(() -> {
        if (minecraft.getConnection() == null) throw ApiException.conflict("not in a world");
        minecraft.getConnection().sendCommand(command);
      });
    }
    ClientThread.awaitFrames(1);
    return ClientThread.call(() -> {
      JsonObject json = new JsonObject();
      var window = minecraft.getWindow();
      JsonObject windowJson = new JsonObject();
      windowJson.addProperty("w", window.getWidth());
      windowJson.addProperty("h", window.getHeight());
      json.add("window", windowJson);
      json.addProperty("guiScale", window.getGuiScale());
      json.addProperty("guiWidth", window.getGuiScaledWidth());
      json.addProperty("guiHeight", window.getGuiScaledHeight());
      json.addProperty("language", minecraft.getLanguageManager().getSelected());
      json.addProperty("holdHud", Scene.holdHud);
      json.addProperty("steadyPlayer", Scene.steadyPlayer);
      json.addProperty("itemName", Scene.itemName);
      json.addProperty("toasts", Scene.toasts);
      json.addProperty("textCursor", Scene.textCursor);
      return json;
    });
  }
}
