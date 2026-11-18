package net.anweisen.agentlens.capture;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.util.Rect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.navigation.ScreenRectangle;

/**
 * Bounding boxes of named GUI parts, measured from what the game really submits for drawing: while a section is
 * open (mixins open and close them around the vanilla extract methods), the bounds of every submitted GUI element
 * are united. Client thread only.
 */
public final class Regions {

  /** A region with the frame it was last drawn in. */
  public record Seen(Rect rect, long frame) {
  }

  public static final String SCREEN = "screen";
  /** A container screen's title; Capture replaces its layout bounds with what the frame shows. */
  public static final String TITLE = "menu-title";

  private static final ArrayDeque<String> OPEN = new ArrayDeque<>();
  private static Map<String, int[]> building = new HashMap<>();
  private static Map<String, Rect> current = Map.of();
  private static Map<String, Rect> overflow = Map.of();
  private static boolean published;
  private static final Map<String, Seen> LAST_SEEN = new HashMap<>();

  private Regions() {
  }

  public static void guiBegin() {
    OPEN.clear();
    building = new LinkedHashMap<>();
  }

  public static void begin(String name) {
    OPEN.push(name);
  }

  public static void end(String name) {
    OPEN.remove(name);
  }

  public static void add(ScreenRectangle bounds) {
    if (OPEN.isEmpty() || bounds == null || bounds.width() <= 0 || bounds.height() <= 0) return;
    boolean tooltip = OPEN.contains("tooltip");
    for (String name : OPEN) {
      if (name.equals(SCREEN)) {
        // the screen region is the screen's own content: not its tooltip, not a backdrop covering the window
        if (tooltip) continue;
        var window = Minecraft.getInstance().getWindow();
        if (bounds.width() * 10 >= window.getGuiScaledWidth() * 9
          && bounds.height() * 10 >= window.getGuiScaledHeight() * 9) {
          continue;
        }
      }
      int[] box = building.get(name);
      if (box == null) {
        building.put(name, new int[] {bounds.left(), bounds.top(), bounds.right(), bounds.bottom()});
      } else {
        box[0] = Math.min(box[0], bounds.left());
        box[1] = Math.min(box[1], bounds.top());
        box[2] = Math.max(box[2], bounds.right());
        box[3] = Math.max(box[3], bounds.bottom());
      }
    }
  }

  public static void guiEnd() {
    var window = Minecraft.getInstance().getWindow();
    int scale = window.getGuiScale();
    Map<String, Rect> rects = new LinkedHashMap<>();
    Map<String, Rect> cut = new LinkedHashMap<>();
    long frame = ClientThread.frame() + 1;
    building.forEach((name, box) -> {
      Rect drawn = new Rect(box[0], box[1], box[2] - box[0], box[3] - box[1]).scale(scale);
      Rect rect = drawn.clamp(window.getWidth(), window.getHeight());
      if (rect.isEmpty()) return;
      if (!rect.equals(drawn)) cut.put(name, drawn);
      rects.put(name, rect);
      LAST_SEEN.put(name, new Seen(rect, frame));
    });
    current = rects;
    overflow = cut;
    published = true;
  }

  public static void frameEnd() {
    if (!published) {
      current = Map.of();
      overflow = Map.of();
    }
    published = false;
  }

  /** Regions drawn in the frame that just completed, in framebuffer pixels. */
  public static Map<String, Rect> current() {
    return current;
  }

  /**
   * Regions of the frame that just completed whose content reaches beyond the window, with their unclamped
   * bounds: a picture of them would be cut off.
   */
  public static Map<String, Rect> overflow() {
    return overflow;
  }

  public static Seen lastSeen(String name) {
    return LAST_SEEN.get(name);
  }

  public static void forget() {
    LAST_SEEN.clear();
  }
}
