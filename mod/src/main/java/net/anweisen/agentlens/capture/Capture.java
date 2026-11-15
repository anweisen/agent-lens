package net.anweisen.agentlens.capture;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.awt.image.BufferedImage;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.game.Screens;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.util.Rect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;

/** Frame grabs through the game's own readback, and region names resolved against what that frame drew. */
public final class Capture {

  /** A whole frame, ARGB, with the regions that were drawn in it. */
  public record Frame(int[] pixels, int width, int height, Map<String, Rect> regions, int guiScale) {
  }

  public record Shot(Frame frame, Rect rect) {
  }

  private Capture() {
  }

  /** Every region known for the frame that just completed, in framebuffer pixels. Client thread. */
  public static Map<String, Rect> allRegions() {
    Minecraft minecraft = Minecraft.getInstance();
    var window = minecraft.getWindow();
    Map<String, Rect> regions = new LinkedHashMap<>();
    regions.put("full", new Rect(0, 0, window.getWidth(), window.getHeight()));
    regions.putAll(Regions.current());
    Screen screen = minecraft.gui.screen();
    if (screen == null) {
      regions.remove(Regions.SCREEN);
    } else if (screen instanceof AbstractContainerScreen<?> container) {
      // the container panel always counts, plus whatever the screen drew around it (creative tabs, recipe book)
      Rect panel = Screens.toPixels(Screens.containerRect(container));
      regions.put(Regions.SCREEN, panel.union(regions.get(Regions.SCREEN)));
    }
    // opened chat: the lines are drawn by the chat screen, together with the input field and its suggestions
    if (screen instanceof net.minecraft.client.gui.screens.ChatScreen && regions.containsKey(Regions.SCREEN)) {
      regions.putIfAbsent("chat", regions.get(Regions.SCREEN));
    }
    if (regions.containsKey(Regions.SCREEN) && regions.containsKey("tooltip")) {
      regions.put("screen+tooltip", regions.get(Regions.SCREEN).union(regions.get("tooltip")));
    }
    return regions;
  }

  /** Resolves one region spec against a frame's regions. Runs on the client thread for slot and widget lookups. */
  public static Rect resolve(JsonElement spec, Map<String, Rect> regions) {
    if (spec == null || spec.isJsonNull()) return regions.get("full");
    if (spec.isJsonArray()) {
      JsonArray array = spec.getAsJsonArray();
      if (array.isEmpty()) throw ApiException.bad("region array is empty");
      Rect union = null;
      for (JsonElement element : array) union = resolve(element, regions).union(union);
      return union;
    }
    if (spec.isJsonObject()) {
      JsonObject object = spec.getAsJsonObject();
      for (String key : List.of("x", "y", "w", "h")) {
        if (!object.has(key)) throw ApiException.bad("a region rect needs x, y, w and h (framebuffer pixels)");
      }
      Rect rect = new Rect(object.get("x").getAsInt(), object.get("y").getAsInt(), object.get("w").getAsInt(),
        object.get("h").getAsInt());
      if (rect.isEmpty()) throw ApiException.bad("region rect is empty");
      return rect;
    }
    String name = spec.getAsString();
    if (name.startsWith("slot:")) {
      AbstractContainerScreen<?> container = Screens.requireContainer();
      return Screens.toPixels(Screens.slotRect(container, Screens.slot(container, number(name, 5))));
    }
    if (name.startsWith("slots:")) {
      AbstractContainerScreen<?> container = Screens.requireContainer();
      String[] range = name.substring(6).split("-");
      if (range.length != 2) throw ApiException.bad("expected slots:<a>-<b>, got " + name);
      int from = number(range[0], 0);
      int to = number(range[1], 0);
      if (to < from) throw ApiException.bad("expected slots:<a>-<b> with a <= b, got " + name);
      Rect union = null;
      for (int index = from; index <= to; index++) {
        union = Screens.slotRect(container, Screens.slot(container, index)).union(union);
      }
      return Screens.toPixels(union);
    }
    if (name.startsWith("widget:")) {
      return Screens.toPixels(Screens.widget(Screens.require(), name.substring(7)).rect());
    }
    Rect rect = regions.get(name);
    if (rect == null) {
      List<String> known = new ArrayList<>(regions.keySet());
      throw new ApiException(404, "region \"" + name + "\" is not on screen in this frame, available: " + known
        + " (plus slot:<n>, slots:<a>-<b>, widget:<label> on an open screen, or {x, y, w, h})");
    }
    return rect;
  }

  private static int number(String text, int offset) {
    try {
      return Integer.parseInt(text.substring(offset).trim());
    } catch (NumberFormatException error) {
      throw ApiException.bad("not a number in region \"" + text + "\"");
    }
  }

  /** Grabs a frame and resolves the region against exactly that frame. API thread. */
  public static Shot shot(JsonElement region, int pad) {
    CompletableFuture<Rect> rect = new CompletableFuture<>();
    Frame frame = grabWith(regions -> rect.complete(resolve(region, regions)), rect);
    Rect resolved = ClientThread.await(rect, 1000, "the region").pad(pad).clamp(frame.width(), frame.height());
    if (resolved.isEmpty()) throw ApiException.bad("region is empty after clamping to the frame");
    return new Shot(frame, resolved);
  }

  private interface RegionStep {
    void accept(Map<String, Rect> regions);
  }

  private static Frame grabWith(RegionStep step, CompletableFuture<?> stepResult) {
    CompletableFuture<Frame> result = new CompletableFuture<>();
    AtomicBoolean requested = new AtomicBoolean();
    long after = ClientThread.frame();
    CompletableFuture<Void> trigger = ClientThread.whenFrame(() -> {
      if (ClientThread.frame() <= after) return false;
      if (!requested.compareAndSet(false, true)) return true;
      Minecraft minecraft = Minecraft.getInstance();
      Map<String, Rect> regions = allRegions();
      try {
        step.accept(regions);
      } catch (Throwable error) {
        stepResult.completeExceptionally(error);
        result.completeExceptionally(error);
        return true;
      }
      int scale = minecraft.getWindow().getGuiScale();
      Screenshot.takeScreenshot(minecraft.gameRenderer.mainRenderTarget(), image -> {
        try (image) {
          int width = image.getWidth();
          int height = image.getHeight();
          int[] pixels = new int[width * height];
          for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) pixels[y * width + x] = image.getPixel(x, y);
          }
          result.complete(new Frame(pixels, width, height, regions, scale));
        } catch (Throwable error) {
          result.completeExceptionally(error);
        }
      });
      return true;
    });
    ClientThread.await(trigger, 30_000, "a completed frame");
    return ClientThread.await(result, 30_000, "the frame readback");
  }

  public static JsonObject regionsJson(Map<String, Rect> regions) {
    JsonObject json = new JsonObject();
    regions.forEach((name, rect) -> json.add(name, rect.json()));
    return json;
  }

  public static JsonObject write(Shot shot, Path out) {
    BufferedImage image = Images.crop(shot.frame(), shot.rect());
    Images.writePng(image, out);
    JsonObject json = new JsonObject();
    json.addProperty("file", out.toString());
    json.addProperty("width", shot.rect().w());
    json.addProperty("height", shot.rect().h());
    json.add("rect", shot.rect().json());
    json.add("regions", regionsJson(shot.frame().regions()));
    json.addProperty("guiScale", shot.frame().guiScale());
    return json;
  }
}
