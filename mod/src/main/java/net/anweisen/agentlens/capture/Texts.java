package net.anweisen.agentlens.capture;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.game.Screens;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.renderer.state.gui.GuiRenderState;
import net.minecraft.client.renderer.state.gui.GuiTextRenderState;
import net.minecraft.util.FormattedCharSequence;
import org.joml.Matrix3x2f;
import org.joml.Vector2f;

/**
 * Every piece of text the game submitted for one GUI frame, with where it sits: chat lines, dialog text, widget
 * labels, tooltip lines. Read from the frame's render state on request only, so an idle client pays nothing.
 */
public final class Texts {

  /** One submitted text. advances[i] is the local x offset of character i, advances[length] the full width. */
  public record Run(String text, float[] advances, Matrix3x2f pose, int x, int y) {

    /** GUI position of the middle of the characters [from, to), on the text's centre line. */
    public double[] gui(int from, int to) {
      Vector2f point = pose.transformPosition(x + (advances[from] + advances[to]) / 2f, y + 4f, new Vector2f());
      return new double[] {point.x, point.y};
    }
  }

  public record Located(double x, double y, String text, int matches) {
  }

  private static volatile CompletableFuture<List<Run>> pending;

  private Texts() {
  }

  /** API thread. The text of the next GUI frame. */
  public static List<Run> snapshot() {
    CompletableFuture<List<Run>> request = new CompletableFuture<>();
    pending = request;
    return ClientThread.await(request, 5000, "a GUI frame");
  }

  /** Client thread, after the GUI was extracted for a frame and before it is drawn. */
  public static void guiEnd() {
    CompletableFuture<List<Run>> request = pending;
    if (request == null) return;
    pending = null;
    try {
      GuiRenderState state = Reflect.get(Gui.class, Minecraft.getInstance().gui, "guiRenderState");
      List<Run> runs = new ArrayList<>();
      state.forEachText(text -> {
        Run run = run(text);
        if (!run.text().isBlank()) runs.add(run);
      });
      request.complete(runs);
    } catch (Throwable error) {
      request.completeExceptionally(error);
    }
  }

  private static Run run(GuiTextRenderState state) {
    Font font = Reflect.get(GuiTextRenderState.class, state, "font");
    FormattedCharSequence sequence = Reflect.get(GuiTextRenderState.class, state, "text");
    int x = Reflect.get(GuiTextRenderState.class, state, "x");
    int y = Reflect.get(GuiTextRenderState.class, state, "y");
    StringBuilder text = new StringBuilder();
    List<Float> advances = new ArrayList<>();
    float[] width = {0};
    sequence.accept((index, style, codepoint) -> {
      for (int unit = 0; unit < Character.charCount(codepoint); unit++) advances.add(width[0]);
      text.appendCodePoint(codepoint);
      width[0] += font.width(FormattedCharSequence.codepoint(codepoint, style));
      return true;
    });
    advances.add(width[0]);
    float[] offsets = new float[advances.size()];
    for (int index = 0; index < offsets.length; index++) offsets[index] = advances.get(index);
    return new Run(text.toString(), offsets, new Matrix3x2f(state.pose), x, y);
  }

  /**
   * API thread. Where the text matching the pattern (case-insensitive regular expression) is drawn. Of several
   * matches the lowest on screen wins, then the leftmost: in the chat that is the newest line.
   */
  public static Located locate(String wanted) {
    Pattern pattern = Screens.pattern(wanted);
    List<Run> runs = snapshot();
    List<Located> found = new ArrayList<>();
    for (Run run : runs) {
      Matcher matcher = pattern.matcher(run.text());
      while (matcher.find()) {
        if (matcher.end() == matcher.start()) break;
        double[] gui = run.gui(matcher.start(), matcher.end());
        found.add(new Located(gui[0], gui[1], run.text(), 0));
      }
    }
    if (found.isEmpty()) {
      List<String> texts = runs.stream().map(run -> run.text().strip()).distinct().limit(40).toList();
      throw new ApiException(404, "no text like \"" + wanted + "\" is drawn right now, texts: " + texts);
    }
    found.sort(Comparator.comparingDouble(Located::y).reversed().thenComparingDouble(Located::x));
    Located best = found.get(0);
    return new Located(best.x(), best.y(), best.text(), found.size());
  }
}
