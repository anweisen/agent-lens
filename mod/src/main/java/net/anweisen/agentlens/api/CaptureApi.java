package net.anweisen.agentlens.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.nio.file.Path;
import net.anweisen.agentlens.capture.Capture;
import net.anweisen.agentlens.capture.Images;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.game.Scene;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.http.Json;
import net.minecraft.client.Minecraft;

final class CaptureApi {

  private CaptureApi() {
  }

  /** Per-shot overrides (guiScale, hover) around a body, restored afterwards even when the body fails. */
  static <T> T withShotState(JsonObject body, java.util.function.Supplier<T> action) {
    Minecraft minecraft = Minecraft.getInstance();
    int wantedScale = Json.integer(body, "guiScale", 0);
    if (wantedScale < 0 || wantedScale > 16) throw ApiException.bad("guiScale must be 1-16");
    JsonObject hoverSpec = Json.object(body, "hover");
    boolean hoverText = hoverSpec != null && Json.has(hoverSpec, "text");
    int[] previousScale = {-1};
    Scene.Hover[] previousHover = {null};
    boolean[] hoverChanged = {false};
    boolean hideChat = !Json.bool(body, "chat", showsChat(body.get("region")));
    java.util.Set<String> chatShot = chatShot(body.get("region"));
    try {
      // inside the try: a hover target that does not exist must not leave the GUI scale changed
      ClientThread.run(() -> {
        Scene.hideChat = hideChat;
        Scene.chatShot = chatShot;
        if (wantedScale > 0 && wantedScale != minecraft.getWindow().getGuiScale()) {
          previousScale[0] = Scene.forcedGuiScale;
          Scene.forcedGuiScale = wantedScale;
          minecraft.resizeGui();
        }
        if (hoverSpec != null && !hoverText) {
          Scene.Hover target = ScreenApi.parseHover(hoverSpec);
          previousHover[0] = Scene.hover;
          hoverChanged[0] = true;
          Scene.hover = target;
        }
      });
      if (hoverText) {
        // text moves with the GUI scale: look for it only once the shot's scale is laid out
        ClientThread.awaitFrames(1);
        JsonObject located = ScreenApi.locateText(hoverSpec);
        ClientThread.run(() -> {
          Scene.Hover target = ScreenApi.parseHover(located);
          previousHover[0] = Scene.hover;
          hoverChanged[0] = true;
          Scene.hover = target;
        });
      }
      ClientThread.awaitFrames(Math.clamp(Json.integer(body, "settleFrames", 2), 0, 600));
      return action.get();
    } finally {
      ClientThread.run(() -> {
        Scene.hideChat = false;
        Scene.chatShot = null;
        if (hoverChanged[0]) Scene.hover = previousHover[0];
        if (previousScale[0] >= 0) {
          Scene.forcedGuiScale = previousScale[0];
          minecraft.resizeGui();
        }
      });
    }
  }

  /** Chat lines stay in a shot of the whole frame, of the chat itself or of a pixel rect; elsewhere they are noise. */
  private static boolean showsChat(JsonElement region) {
    if (region == null || region.isJsonNull() || region.isJsonObject()) return true;
    if (region.isJsonArray()) {
      for (JsonElement element : region.getAsJsonArray()) if (showsChat(element)) return true;
      return false;
    }
    String name = region.getAsString();
    return name.equals("full") || name.equals("chat");
  }

  /** The named regions of a shot that asks for the chat by name ("chat", or a list with it), else null. */
  private static java.util.Set<String> chatShot(JsonElement region) {
    if (region == null || region.isJsonNull() || region.isJsonObject()) return null;
    java.util.Set<String> names = new java.util.HashSet<>();
    for (JsonElement element : region.isJsonArray() ? region.getAsJsonArray() : java.util.List.of(region)) {
      if (element.isJsonPrimitive()) names.add(element.getAsString());
    }
    return names.contains("chat") ? names : null;
  }

  static JsonElement capture(JsonObject body) {
    Path out = Images.outPath(Json.string(body, "out", null));
    int pad = Math.max(0, Json.integer(body, "pad", 0));
    JsonElement region = body.get("region");
    boolean fit = Json.bool(body, "fit", false);
    int waitMs = Math.clamp(Json.integer(body, "waitMs", 1000), 0, 60_000);
    java.util.Set<String> names = Capture.names(region);
    return withShotState(body, () -> {
      awaitRegions(names, waitMs);
      int[] previous = fit ? fitWindow(names, pad) : null;
      try {
        Capture.Shot shot = Capture.shot(region, pad);
        JsonObject json = Capture.write(shot, out);
        ClientThread.run(() -> {
          JsonElement hovered = ScreenApi.hovered();
          if (hovered != null) json.add("hovered", hovered);
          com.google.gson.JsonArray clipped = new com.google.gson.JsonArray();
          var window = Minecraft.getInstance().getWindow();
          // larger than the window: part of the content is missing from the picture. Hanging over an edge alone
          // is not: a tooltip the game pushed against an edge only loses its transparent margin.
          overflowing(names).forEach((name, drawn) -> {
            if (drawn.w() > window.getWidth() || drawn.h() > window.getHeight()) clipped.add(name);
          });
          if (!clipped.isEmpty()) json.add("clipped", clipped);
        });
        if (previous != null) json.add("fitted", shot.frame().regions().get("full").json());
        if (!json.has("hovered") && shot.frame().regions().containsKey("tooltip")) {
          json.add("tooltipText", ScreenApi.tooltipText());
        }
        return json;
      } finally {
        if (previous != null) GameApi.resizeWindow(previous[0], previous[1]);
      }
    });
  }

  /** A tooltip follows the hover by a frame or two, a screen follows a click: give named regions time to appear. */
  private static void awaitRegions(java.util.Set<String> names, int waitMs) {
    if (names.isEmpty() || waitMs <= 0) return;
    try {
      ClientThread.awaitUntil(() -> Capture.allRegions().keySet().containsAll(names), waitMs, "the regions");
    } catch (ApiException missing) {
      // the shot itself reports which region is missing and what is there instead
    }
  }

  private static java.util.Map<String, net.anweisen.agentlens.util.Rect> overflowing(java.util.Set<String> names) {
    java.util.Map<String, net.anweisen.agentlens.util.Rect> cut = new java.util.LinkedHashMap<>(
      net.anweisen.agentlens.capture.Regions.overflow());
    cut.keySet().retainAll(names);
    return cut;
  }

  /**
   * Enlarges the window until none of the named regions reaches beyond it (a tooltip taller than the window, a
   * panel wider than it), so the picture shows all of the content at the wanted GUI scale. Returns the previous
   * window size when it changed it, else null.
   */
  /** Up to this size the window also grows to give content room beside the mouse, beyond it only to hold it. */
  private static final int FIT_ROOM_W = 3840;
  private static final int FIT_ROOM_H = 2160;

  private static int[] fitWindow(java.util.Set<String> names, int pad) {
    Minecraft minecraft = Minecraft.getInstance();
    int[] previous = null;
    for (int attempt = 0; attempt < 4 && !names.isEmpty(); attempt++) {
      int[] wanted = ClientThread.call(() -> {
        var window = minecraft.getWindow();
        int margin = 2 * pad + 16 * window.getGuiScale();
        int width = window.getWidth();
        int height = window.getHeight();
        for (net.anweisen.agentlens.util.Rect drawn : overflowing(names).values()) {
          // large enough for the content, and when it is but the content still hangs over an edge (a tooltip
          // beside the mouse): the layout is centred, so twice the overhang moves that edge far enough
          int overX = Math.max(0, -drawn.x()) + Math.max(0, drawn.right() - window.getWidth());
          int overY = Math.max(0, -drawn.y()) + Math.max(0, drawn.bottom() - window.getHeight());
          width = Math.max(width, drawn.w() + margin);
          height = Math.max(height, drawn.h() + margin);
          if (overX > 0) width = Math.max(width, Math.min(FIT_ROOM_W, window.getWidth() + 2 * overX + margin));
          if (overY > 0) height = Math.max(height, Math.min(FIT_ROOM_H, window.getHeight() + 2 * overY + margin));
        }
        // even sizes: video encoders and some drivers want them
        width = Math.min(GameApi.MAX_WINDOW_W, width + (width & 1));
        height = Math.min(GameApi.MAX_WINDOW_H, height + (height & 1));
        return new int[] {width, height, window.getWidth(), window.getHeight()};
      });
      if (wanted[0] == wanted[2] && wanted[1] == wanted[3]) break;
      if (previous == null) previous = new int[] {wanted[2], wanted[3]};
      GameApi.resizeWindow(wanted[0], wanted[1]);
      ClientThread.awaitFrames(3);
    }
    return previous;
  }
}
