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
import net.anweisen.agentlens.game.Scene;
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

  /** A picture's frame and rect; cut names the measured regions that reach beyond the window, i.e. are cut off. */
  public record Shot(Frame frame, Rect rect, List<String> cut) {
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
    // Content that fits the window but hangs over an edge (a tooltip the game pushed against it: only its
    // transparent margin is outside) is trimmed by the same amount on the opposite side, so it stays centred.
    Regions.overflow().forEach((name, drawn) -> {
      if (drawn.w() > window.getWidth() || drawn.h() > window.getHeight()) return;
      int cutX = Math.max(Math.max(0, -drawn.x()), Math.max(0, drawn.right() - window.getWidth()));
      int cutY = Math.max(Math.max(0, -drawn.y()), Math.max(0, drawn.bottom() - window.getHeight()));
      Rect trimmed = new Rect(drawn.x() + cutX, drawn.y() + cutY, drawn.w() - 2 * cutX, drawn.h() - 2 * cutY);
      if (!trimmed.isEmpty()) regions.put(name, trimmed);
    });
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
    if (name.startsWith("item:")) {
      AbstractContainerScreen<?> container = Screens.requireContainer();
      int index = Screens.slotByItem(container, name.substring(5));
      return Screens.toPixels(Screens.slotRect(container, Screens.slot(container, index)));
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
        + " (plus slot:<n>, slots:<a>-<b>, item:<name>, widget:<label> on an open screen, or {x, y, w, h})");
    }
    return rect;
  }

  /** The measured regions a spec names ("screen+tooltip" counts as both); slots, widgets and rects are not. */
  public static java.util.Set<String> names(JsonElement spec) {
    java.util.Set<String> names = new java.util.LinkedHashSet<>();
    if (spec == null || spec.isJsonNull() || spec.isJsonObject()) return names;
    for (JsonElement element : spec.isJsonArray() ? spec.getAsJsonArray() : List.of(spec)) {
      if (!element.isJsonPrimitive()) continue;
      String name = element.getAsString();
      if (name.equals("full") || name.contains(":")) continue;
      if (name.equals("screen+tooltip")) names.addAll(List.of(Regions.SCREEN, "tooltip"));
      else names.add(name);
    }
    return names;
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
    boolean[] atEdge = {false};
    Frame frame = grabWith(regions -> {
      atEdge[0] = !java.util.Collections.disjoint(names(region), Regions.overflow().keySet());
      rect.complete(resolve(region, regions));
    }, rect);
    Rect found = ClientThread.await(rect, 1000, "the region");
    List<String> cut = new ArrayList<>();
    java.util.Set<String> names = names(region);
    if ((names.contains(Regions.SCREEN) || names.contains(Regions.TITLE)) && frame.regions().containsKey(Regions.TITLE)) {
      Rect drawn = measureTitle(frame);
      if (drawn != null) {
        Map<String, Rect> regions = new LinkedHashMap<>(frame.regions());
        regions.put(Regions.TITLE, drawn);
        regions.computeIfPresent(Regions.SCREEN, (name, screen) -> screen.union(drawn));
        regions.computeIfPresent("screen+tooltip", (name, both) -> both.union(drawn));
        frame = new Frame(frame.pixels(), frame.width(), frame.height(), regions, frame.guiScale());
        Map<String, Rect> measured = regions;
        found = ClientThread.call(() -> resolve(region, measured));
        if (drawn.y() <= 0 || drawn.x() <= 0 || drawn.right() >= frame.width()) cut.add(Regions.TITLE);
        // the title's layout bounds overflow for no reason (a plate's spacing glyphs): only what was measured counts
        java.util.Set<String> others = new java.util.HashSet<>(names);
        others.remove(Regions.TITLE);
        atEdge[0] = !cut.isEmpty() || !java.util.Collections.disjoint(others, Regions.overflow().keySet());
      }
    }
    Rect padded = found.pad(pad);
    if (atEdge[0]) {
      // the padding of a region lying against the window edge shrinks on both sides alike
      int cutX = Math.max(Math.max(0, -padded.x()), Math.max(0, padded.right() - frame.width()));
      int cutY = Math.max(Math.max(0, -padded.y()), Math.max(0, padded.bottom() - frame.height()));
      padded = new Rect(padded.x() + cutX, padded.y() + cutY, padded.w() - 2 * cutX, padded.h() - 2 * cutY);
    }
    Rect resolved = padded.clamp(frame.width(), frame.height());
    if (resolved.isEmpty()) throw ApiException.bad("region is empty after clamping to the frame");
    return new Shot(frame, resolved, cut);
  }

  /**
   * Where the container title really is: a resource pack's text shader can move it (a menu title plate lifted
   * above the panel), which its layout bounds never show. Two more frames, one without the title and one with it
   * again: the pixels the title changes, minus those that changed anyway (an animated world behind the menu),
   * near the layout bounds. Null when nothing changed. API thread.
   */
  private static Rect measureTitle(Frame shown) {
    Rect layout = shown.regions().get(Regions.TITLE);
    Rect panel = shown.regions().getOrDefault(Regions.SCREEN, layout);
    int scale = Math.max(1, shown.guiScale());
    int left = Math.max(0, Math.min(layout.x(), panel.x()) - 16 * scale);
    int right = Math.min(shown.width(), Math.max(layout.right(), panel.right()) + 16 * scale);
    int top = Math.max(0, layout.y() - 64 * scale);
    int bottom = Math.min(shown.height(), layout.bottom() + 8 * scale);
    Frame hidden;
    ClientThread.run(() -> Scene.hideTitle = true);
    try {
      hidden = grab();
    } finally {
      ClientThread.run(() -> Scene.hideTitle = false);
    }
    Frame again = grab();
    if (hidden.width() != shown.width() || again.width() != shown.width()
      || hidden.height() != shown.height() || again.height() != shown.height()) {
      return null;
    }
    int width = shown.width();
    int rows = bottom - top;
    int[] rowMin = new int[rows];
    int[] rowMax = new int[rows];
    boolean[] changed = new boolean[rows];
    for (int y = top; y < bottom; y++) {
      int first = Integer.MAX_VALUE, last = -1, count = 0;
      for (int x = left; x < right; x++) {
        int index = y * width + x;
        int pixel = shown.pixels()[index];
        if (!differs(pixel, hidden.pixels()[index]) || differs(pixel, again.pixels()[index])) continue;
        count++;
        first = Math.min(first, x);
        last = Math.max(last, x);
      }
      // a single pixel is noise (a particle), a title row has more
      changed[y - top] = count >= 2;
      rowMin[y - top] = first;
      rowMax[y - top] = last;
    }
    // the title is one band of rows; changes elsewhere (an animated item, the world) are separated by a gap. Take
    // the band nearest to where the layout puts the title's first line.
    int anchor = Math.clamp(layout.y() - top, 0, rows - 1);
    int seed = -1;
    for (int distance = 0; distance < rows && seed < 0; distance++) {
      if (anchor - distance >= 0 && changed[anchor - distance]) seed = anchor - distance;
      else if (anchor + distance < rows && changed[anchor + distance]) seed = anchor + distance;
    }
    if (seed < 0) return null;
    int gap = 2 * scale;
    int from = seed, to = seed;
    for (int y = seed - 1, empty = 0; y >= 0 && empty <= gap; y--) {
      if (changed[y]) {
        from = y;
        empty = 0;
      } else empty++;
    }
    for (int y = seed + 1, empty = 0; y < rows && empty <= gap; y++) {
      if (changed[y]) {
        to = y;
        empty = 0;
      } else empty++;
    }
    int minX = Integer.MAX_VALUE, maxX = -1;
    for (int y = from; y <= to; y++) {
      if (!changed[y]) continue;
      minX = Math.min(minX, rowMin[y]);
      maxX = Math.max(maxX, rowMax[y]);
    }
    return new Rect(minX, top + from, maxX - minX + 1, to - from + 1);
  }

  private static boolean differs(int a, int b) {
    for (int shift = 0; shift < 24; shift += 8) {
      if (Math.abs(((a >> shift) & 0xFF) - ((b >> shift) & 0xFF)) > 24) return true;
    }
    return false;
  }

  private static Frame grab() {
    return grabWith(regions -> { }, new CompletableFuture<Void>());
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
