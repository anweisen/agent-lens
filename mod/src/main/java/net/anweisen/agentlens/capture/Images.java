package net.anweisen.agentlens.capture;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.ImageIO;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.util.Rect;

/** PNG reading and writing, and the pixel helpers the sheet and compose layouts use. */
public final class Images {

  private Images() {
  }

  public static Path outPath(String out) {
    if (out == null || out.isBlank()) throw ApiException.bad("\"out\" is required (absolute path)");
    Path path = Path.of(out);
    if (!path.isAbsolute()) throw ApiException.bad("\"out\" must be an absolute path: " + out);
    return path.normalize();
  }

  /** Smallest lossless PNG: encoded in memory, written to disk once. */
  public static void writePng(BufferedImage image, Path path) {
    writePng(image, path, true);
  }

  /** small = false: fast encoding for files that are deleted again (video frames). */
  public static void writePng(BufferedImage image, Path path, boolean small) {
    try {
      byte[] bytes = encodePng(image, small ? 0f : 0.9f);
      if (small) {
        // GUI shots have few colours: a palette image is often a fraction of the RGB one
        BufferedImage indexed = indexed(image);
        if (indexed != null) {
          byte[] other = encodePng(indexed, 0f);
          if (other.length < bytes.length) bytes = other;
        }
      }
      if (path.getParent() != null) Files.createDirectories(path.getParent());
      // write next to the target and rename, so a reader never sees half a file
      Path tmp = path.resolveSibling(path.getFileName() + ".part");
      Files.write(tmp, bytes);
      Files.move(tmp, path, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    } catch (IOException error) {
      throw new ApiException(500, "cannot write " + path + ": " + error.getMessage());
    }
  }

  /** quality as ImageIO counts it: 0 = deflate level 9. */
  private static byte[] encodePng(BufferedImage image, float quality) throws IOException {
    javax.imageio.ImageWriter writer = ImageIO.getImageWritersByFormatName("png").next();
    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(1 << 16);
    try (var stream = new javax.imageio.stream.MemoryCacheImageOutputStream(bytes)) {
      javax.imageio.ImageWriteParam param = writer.getDefaultWriteParam();
      param.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT);
      param.setCompressionQuality(quality);
      writer.setOutput(stream);
      writer.write(null, new javax.imageio.IIOImage(image, null, null), param);
    } finally {
      writer.dispose();
    }
    return bytes.toByteArray();
  }

  /** The same pixels with a palette, or null when the image has more than 256 colours. */
  private static BufferedImage indexed(BufferedImage image) {
    int width = image.getWidth();
    int height = image.getHeight();
    int[] pixels = image.getRGB(0, 0, width, height, null, 0, width);
    java.util.HashMap<Integer, Integer> palette = new java.util.HashMap<>();
    byte[] data = new byte[pixels.length];
    for (int index = 0; index < pixels.length; index++) {
      int rgb = pixels[index] & 0xffffff;
      Integer slot = palette.get(rgb);
      if (slot == null) {
        if (palette.size() == 256) return null;
        slot = palette.size();
        palette.put(rgb, slot);
      }
      data[index] = (byte) (int) slot;
    }
    byte[] red = new byte[palette.size()];
    byte[] green = new byte[palette.size()];
    byte[] blue = new byte[palette.size()];
    palette.forEach((rgb, slot) -> {
      red[slot] = (byte) (rgb >> 16);
      green[slot] = (byte) (rgb >> 8);
      blue[slot] = (byte) (int) rgb;
    });
    int bits = palette.size() <= 2 ? 1 : palette.size() <= 4 ? 2 : palette.size() <= 16 ? 4 : 8;
    var model = new java.awt.image.IndexColorModel(bits, palette.size(), red, green, blue);
    BufferedImage result = new BufferedImage(width, height,
      bits == 8 ? BufferedImage.TYPE_BYTE_INDEXED : BufferedImage.TYPE_BYTE_BINARY, model);
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) result.getRaster().setSample(x, y, 0, data[y * width + x] & 0xff);
    }
    return result;
  }

  public static BufferedImage read(String file) {
    Path path = Path.of(file);
    if (!path.isAbsolute()) throw ApiException.bad("image paths must be absolute: " + file);
    try {
      BufferedImage image = ImageIO.read(new File(file));
      if (image == null) throw ApiException.bad("not a readable image: " + file);
      return image;
    } catch (IOException error) {
      throw ApiException.bad("cannot read " + file + ": " + error.getMessage());
    }
  }

  public static BufferedImage crop(Capture.Frame frame, Rect rect) {
    BufferedImage image = new BufferedImage(rect.w(), rect.h(), BufferedImage.TYPE_INT_RGB);
    for (int y = 0; y < rect.h(); y++) {
      image.setRGB(0, y, rect.w(), 1, frame.pixels(), (rect.y() + y) * frame.width() + rect.x(), frame.width());
    }
    return image;
  }

  public static void fill(BufferedImage image, int x, int y, int width, int height, int rgb) {
    for (int py = Math.max(0, y); py < Math.min(image.getHeight(), y + height); py++) {
      for (int px = Math.max(0, x); px < Math.min(image.getWidth(), x + width); px++) image.setRGB(px, py, rgb);
    }
  }

  /** Nearest-neighbour copy at an integer scale. */
  public static void blit(BufferedImage target, BufferedImage source, int x, int y, int scale) {
    for (int sy = 0; sy < source.getHeight(); sy++) {
      for (int sx = 0; sx < source.getWidth(); sx++) {
        int rgb = source.getRGB(sx, sy) | 0xff000000;
        if (scale == 1) {
          target.setRGB(x + sx, y + sy, rgb);
        } else {
          for (int dy = 0; dy < scale; dy++) {
            for (int dx = 0; dx < scale; dx++) target.setRGB(x + sx * scale + dx, y + sy * scale + dy, rgb);
          }
        }
      }
    }
  }

  public static boolean same(BufferedImage a, BufferedImage b) {
    if (a.getWidth() != b.getWidth() || a.getHeight() != b.getHeight()) return false;
    for (int y = 0; y < a.getHeight(); y++) {
      for (int x = 0; x < a.getWidth(); x++) if (a.getRGB(x, y) != b.getRGB(x, y)) return false;
    }
    return true;
  }
}
