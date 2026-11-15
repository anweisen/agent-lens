package net.anweisen.agentlens.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.awt.image.BufferedImage;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import net.anweisen.agentlens.capture.BitmapFont;
import net.anweisen.agentlens.capture.Capture;
import net.anweisen.agentlens.capture.Gif;
import net.anweisen.agentlens.capture.Images;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.game.Ticks;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.http.Json;
import net.anweisen.agentlens.util.Rect;

final class FramesApi {

  private static final int BACKGROUND = 0x202225;
  private static final int LABEL_BAR = 0x2f3136;
  private static final int LABEL_TEXT = 0xffffff;

  private FramesApi() {
  }

  static JsonElement frames(JsonObject body) {
    Path out = Images.outPath(Json.string(body, "out", null));
    int count = Json.integer(body, "count", 8);
    if (count < 1 || count > 200) throw ApiException.bad("count must be 1-200");
    int interval = Json.integer(body, "intervalTicks", 2);
    if (interval < 0 || interval > 200) throw ApiException.bad("intervalTicks must be 0-200");
    String format = Json.string(body, "format", "sheet");
    if (!List.of("gif", "sheet", "png-sequence").contains(format)) {
      throw ApiException.bad("format must be gif, sheet or png-sequence");
    }
    int pad = Math.max(0, Json.integer(body, "pad", 0));
    JsonElement region = body.get("region");

    List<BufferedImage> images = new ArrayList<>();
    Rect[] rect = {null};
    long[] ticks = new long[count];
    CaptureApi.withShotState(body, () -> {
      long start = ClientThread.call(Ticks::client);
      for (int index = 0; index < count; index++) {
        if (index > 0) {
          if (interval > 0) {
            // absolute targets, so the time a readback takes does not add up over the sequence
            long target = start + (long) index * interval;
            ClientThread.awaitUntil(() -> Ticks.client() >= target, 5000L + interval * 200L, "client tick " + target);
          } else {
            ClientThread.awaitFrames(1);
          }
        }
        // the first frame fixes the crop, so a region that moves or vanishes cannot change the frame size
        Capture.Shot shot = rect[0] == null ? Capture.shot(region, pad) : Capture.shot(rect[0].json(), 0);
        if (rect[0] == null) rect[0] = shot.rect();
        ticks[index] = ClientThread.call(Ticks::client);
        images.add(Images.crop(shot.frame(), shot.rect()));
      }
      return null;
    });

    JsonObject json = new JsonObject();
    json.addProperty("format", format);
    json.addProperty("count", count);
    json.add("rect", rect[0].json());
    JsonArray tickArray = new JsonArray();
    for (long tick : ticks) tickArray.add(tick - ticks[0]);
    json.add("ticks", tickArray);
    switch (format) {
      case "png-sequence" -> {
        String name = out.getFileName().toString();
        boolean prefix = name.toLowerCase(java.util.Locale.ROOT).endsWith(".png");
        Path dir = prefix ? out.getParent() : out;
        String stem = prefix ? name.substring(0, name.length() - 4) : "frame";
        JsonArray files = new JsonArray();
        for (int index = 0; index < images.size(); index++) {
          Path file = dir.resolve(String.format("%s-%03d.png", stem, index));
          Images.writePng(images.get(index), file);
          files.add(file.toString());
        }
        json.add("files", files);
      }
      case "sheet" -> {
        int columns = Json.integer(body, "columns", (int) Math.ceil(Math.sqrt(count)));
        if (columns < 1) throw ApiException.bad("columns must be at least 1");
        columns = Math.min(columns, count);
        int rows = (count + columns - 1) / columns;
        int gap = 4;
        int width = rect[0].w();
        int height = rect[0].h();
        BufferedImage sheet = new BufferedImage(columns * width + (columns + 1) * gap,
          rows * height + (rows + 1) * gap, BufferedImage.TYPE_INT_RGB);
        Images.fill(sheet, 0, 0, sheet.getWidth(), sheet.getHeight(), BACKGROUND);
        for (int index = 0; index < images.size(); index++) {
          Images.blit(sheet, images.get(index), gap + (index % columns) * (width + gap),
            gap + (index / columns) * (height + gap), 1);
        }
        Images.writePng(sheet, out);
        json.addProperty("file", out.toString());
        json.addProperty("width", sheet.getWidth());
        json.addProperty("height", sheet.getHeight());
        json.addProperty("columns", columns);
        json.addProperty("rows", rows);
      }
      default -> {
        int delayMs = Json.integer(body, "delayMs", Math.max(1, interval) * 50);
        Gif.write(images, out, delayMs);
        json.addProperty("file", out.toString());
        json.addProperty("width", rect[0].w());
        json.addProperty("height", rect[0].h());
        json.addProperty("delayMs", delayMs);
      }
    }
    return json;
  }

  static JsonElement compose(JsonObject body) {
    Path out = Images.outPath(Json.string(body, "out", null));
    BufferedImage before = Images.read(Json.require(body, "before"));
    BufferedImage after = Images.read(Json.require(body, "after"));
    String[] labels = {"Vorher", "Nachher"};
    if (Json.has(body, "labels")) {
      if (!body.get("labels").isJsonArray() || body.getAsJsonArray("labels").size() != 2) {
        throw ApiException.bad("labels must be an array of two strings");
      }
      labels[0] = body.getAsJsonArray("labels").get(0).getAsString();
      labels[1] = body.getAsJsonArray("labels").get(1).getAsString();
    }
    String layout = Json.string(body, "layout", "row");
    if (!layout.equals("row") && !layout.equals("column")) throw ApiException.bad("layout must be row or column");
    int scale = Json.integer(body, "scale", 1);
    if (scale < 1 || scale > 16) throw ApiException.bad("scale must be an integer 1-16");
    BufferedImage[] images = {before, after};
    int cellWidth = Math.max(before.getWidth(), after.getWidth()) * scale;
    int cellHeight = Math.max(before.getHeight(), after.getHeight()) * scale;
    if ((long) cellWidth * cellHeight > 64_000_000L) throw ApiException.bad("composed image would be too large");

    // label text grows with the picture but stays an integer multiple of the 8 px font
    int textScale = Math.clamp(Math.min(cellWidth, 1200) / 200, 2, 4);
    for (int index = 0; index < 2; index++) {
      labels[index] = BitmapFont.ascii(labels[index]);
      while (textScale > 1 && BitmapFont.width(labels[index], textScale) > cellWidth - 8) textScale--;
    }
    int bar = BitmapFont.height(textScale) + 6 * textScale;
    int gap = 8;
    boolean row = layout.equals("row");
    int width = row ? 2 * cellWidth + 3 * gap : cellWidth + 2 * gap;
    int height = row ? bar + cellHeight + 2 * gap : 2 * (bar + cellHeight) + 3 * gap;
    BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
    Images.fill(image, 0, 0, width, height, BACKGROUND);
    JsonArray cells = new JsonArray();
    for (int index = 0; index < 2; index++) {
      int x = gap + (row ? index * (cellWidth + gap) : 0);
      int y = gap + (row ? 0 : index * (bar + cellHeight + gap));
      Images.fill(image, x, y, cellWidth, bar, LABEL_BAR);
      BitmapFont.draw(image, labels[index], x + (cellWidth - BitmapFont.width(labels[index], textScale)) / 2,
        y + 3 * textScale, textScale, LABEL_TEXT);
      BufferedImage source = images[index];
      int imageX = x + (cellWidth - source.getWidth() * scale) / 2;
      int imageY = y + bar;
      Images.blit(image, source, imageX, imageY, scale);
      cells.add(new Rect(imageX, imageY, source.getWidth() * scale, source.getHeight() * scale).json());
    }
    Images.writePng(image, out);
    JsonObject json = new JsonObject();
    json.addProperty("file", out.toString());
    json.addProperty("width", width);
    json.addProperty("height", height);
    json.add("cells", cells);
    json.addProperty("identical", Images.same(before, after));
    return json;
  }
}
