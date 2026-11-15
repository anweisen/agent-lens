package net.anweisen.agentlens.capture;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import javax.imageio.ImageIO;
import net.anweisen.agentlens.http.ApiException;
import net.minecraft.client.Minecraft;

/**
 * Label text without Java2D fonts: a headless JDK without fontconfig cannot draw strings at all. Glyphs come from
 * the game's own 8x8 ASCII sheet in the client jar, so labels look like Minecraft text.
 */
public final class BitmapFont {

  private static final int CELL = 8;
  private static boolean[][][] glyphs;
  private static int[] widths;

  private BitmapFont() {
  }

  private static synchronized void load() {
    if (glyphs != null) return;
    try (InputStream in = Minecraft.class.getResourceAsStream("/assets/minecraft/textures/font/ascii.png")) {
      if (in == null) throw new IOException("font sheet not found in the client jar");
      BufferedImage sheet = ImageIO.read(in);
      boolean[][][] loaded = new boolean[128][CELL][CELL];
      int[] loadedWidths = new int[128];
      for (int code = 32; code < 127; code++) {
        int left = (code % 16) * CELL;
        int top = (code / 16) * CELL;
        int width = 0;
        for (int y = 0; y < CELL; y++) {
          for (int x = 0; x < CELL; x++) {
            boolean set = (sheet.getRGB(left + x, top + y) >>> 24) > 127;
            loaded[code][y][x] = set;
            if (set) width = Math.max(width, x + 1);
          }
        }
        loadedWidths[code] = code == ' ' ? 4 : width + 1;
      }
      glyphs = loaded;
      widths = loadedWidths;
    } catch (IOException error) {
      throw new ApiException(500, "cannot load the label font: " + error.getMessage());
    }
  }

  public static String ascii(String text) {
    StringBuilder out = new StringBuilder();
    for (char c : text.toCharArray()) {
      switch (c) {
        case 'ä' -> out.append("ae");
        case 'ö' -> out.append("oe");
        case 'ü' -> out.append("ue");
        case 'Ä' -> out.append("Ae");
        case 'Ö' -> out.append("Oe");
        case 'Ü' -> out.append("Ue");
        case 'ß' -> out.append("ss");
        default -> out.append(c >= 32 && c < 127 ? c : '?');
      }
    }
    return out.toString();
  }

  /** Width in pixels at the given integer scale. Text must be ASCII (see {@link #ascii}). */
  public static int width(String text, int scale) {
    load();
    int width = 0;
    for (char c : text.toCharArray()) width += widths[c];
    return Math.max(0, width - 1) * scale;
  }

  public static int height(int scale) {
    return CELL * scale;
  }

  public static void draw(BufferedImage image, String text, int x, int y, int scale, int rgb) {
    load();
    int cursor = x;
    for (char c : text.toCharArray()) {
      for (int gy = 0; gy < CELL; gy++) {
        for (int gx = 0; gx < CELL; gx++) {
          if (!glyphs[c][gy][gx]) continue;
          for (int sy = 0; sy < scale; sy++) {
            for (int sx = 0; sx < scale; sx++) {
              int px = cursor + gx * scale + sx;
              int py = y + gy * scale + sy;
              if (px >= 0 && py >= 0 && px < image.getWidth() && py < image.getHeight()) image.setRGB(px, py, rgb);
            }
          }
        }
      }
      cursor += widths[c] * scale;
    }
  }
}
