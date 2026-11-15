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
    int[] previousScale = {-1};
    Scene.Hover[] previousHover = {null};
    boolean[] hoverChanged = {false};
    boolean hideChat = !Json.bool(body, "chat", showsChat(body.get("region")));
    java.util.Set<String> chatShot = chatShot(body.get("region"));
    ClientThread.run(() -> {
      Scene.hideChat = hideChat;
      Scene.chatShot = chatShot;
      if (wantedScale > 0 && wantedScale != minecraft.getWindow().getGuiScale()) {
        previousScale[0] = Scene.forcedGuiScale;
        Scene.forcedGuiScale = wantedScale;
        minecraft.resizeGui();
      }
      if (hoverSpec != null) {
        previousHover[0] = Scene.hover;
        hoverChanged[0] = true;
        Scene.hover = ScreenApi.parseHover(hoverSpec);
      }
    });
    try {
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
    Capture.Shot shot = withShotState(body, () -> Capture.shot(region, pad));
    return Capture.write(shot, out);
  }
}
