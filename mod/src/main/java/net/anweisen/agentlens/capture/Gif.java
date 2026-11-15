package net.anweisen.agentlens.capture;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageTypeSpecifier;
import javax.imageio.ImageWriter;
import javax.imageio.metadata.IIOMetadata;
import javax.imageio.metadata.IIOMetadataNode;
import javax.imageio.stream.ImageOutputStream;
import net.anweisen.agentlens.http.ApiException;

/** Looping animated GIF through ImageIO. */
public final class Gif {

  private Gif() {
  }

  public static void write(List<BufferedImage> images, Path out, int delayMs) {
    ImageWriter writer = ImageIO.getImageWritersByFormatName("gif").next();
    try {
      if (out.getParent() != null) Files.createDirectories(out.getParent());
      Path tmp = out.resolveSibling(out.getFileName() + ".part");
      Files.deleteIfExists(tmp);
      try (ImageOutputStream stream = ImageIO.createImageOutputStream(tmp.toFile())) {
        writer.setOutput(stream);
        writer.prepareWriteSequence(null);
        for (BufferedImage image : images) {
          ImageTypeSpecifier type = ImageTypeSpecifier.createFromRenderedImage(image);
          IIOMetadata metadata = writer.getDefaultImageMetadata(type, null);
          String formatName = metadata.getNativeMetadataFormatName();
          IIOMetadataNode root = (IIOMetadataNode) metadata.getAsTree(formatName);
          IIOMetadataNode control = child(root, "GraphicControlExtension");
          control.setAttribute("disposalMethod", "none");
          control.setAttribute("userInputFlag", "FALSE");
          control.setAttribute("transparentColorFlag", "FALSE");
          control.setAttribute("delayTime", Integer.toString(Math.max(2, delayMs / 10)));
          control.setAttribute("transparentColorIndex", "0");
          IIOMetadataNode extensions = child(root, "ApplicationExtensions");
          IIOMetadataNode loop = new IIOMetadataNode("ApplicationExtension");
          loop.setAttribute("applicationID", "NETSCAPE");
          loop.setAttribute("authenticationCode", "2.0");
          loop.setUserObject(new byte[] {1, 0, 0});
          extensions.appendChild(loop);
          metadata.setFromTree(formatName, root);
          writer.writeToSequence(new IIOImage(image, null, metadata), null);
        }
        writer.endWriteSequence();
      }
      Files.move(tmp, out, StandardCopyOption.REPLACE_EXISTING);
    } catch (IOException error) {
      throw new ApiException(500, "cannot write " + out + ": " + error.getMessage());
    } finally {
      writer.dispose();
    }
  }

  private static IIOMetadataNode child(IIOMetadataNode root, String name) {
    for (int index = 0; index < root.getLength(); index++) {
      if (root.item(index).getNodeName().equalsIgnoreCase(name)) return (IIOMetadataNode) root.item(index);
    }
    IIOMetadataNode node = new IIOMetadataNode(name);
    root.appendChild(node);
    return node;
  }
}
