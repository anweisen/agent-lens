package net.anweisen.agentlens.audio;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.List;
import net.anweisen.agentlens.capture.BitmapFont;
import net.anweisen.agentlens.capture.Images;

/**
 * What a recording contains, for a reader that cannot listen: levels, where sound starts (onsets) and a waveform
 * picture with a tick grid and the sounds the game started.
 */
public final class Analysis {

  /** One level value per 5 ms. */
  private static final int WINDOW_MS = 5;
  private static final double FLOOR_DB = -90;
  private static final double AUDIBLE_DB = -60;
  private static final double ONSET_DB = -45;
  private static final double ONSET_RISE_DB = 10;

  public record Onset(double ms, double db) {
  }

  /** A sound the game started while recording; ms is the position in the recording. */
  public record Marker(double ms, String label) {
  }

  private final Wav wav;
  private final double[] levels;
  private final int peak;
  private final double peakDb;
  private final double rmsDb;
  private final List<Onset> onsets = new ArrayList<>();

  public Analysis(Wav wav) {
    this.wav = wav;
    int window = wav.rate() * WINDOW_MS / 1000;
    int channels = wav.channels();
    short[] samples = wav.samples();
    levels = new double[wav.frames() / window];
    int peak = 0;
    double total = 0;
    for (int index = 0; index < levels.length; index++) {
      double sum = 0;
      for (int frame = index * window; frame < (index + 1) * window; frame++) {
        double mono = 0;
        for (int channel = 0; channel < channels; channel++) {
          int value = samples[frame * channels + channel];
          peak = Math.max(peak, Math.abs(value));
          mono += value;
        }
        mono /= channels * 32768.0;
        sum += mono * mono;
      }
      total += sum;
      levels[index] = db(Math.sqrt(sum / window));
    }
    this.peak = peak;
    peakDb = db(peak / 32768.0);
    rmsDb = levels.length == 0 ? FLOOR_DB : db(Math.sqrt(total / (levels.length * window)));
    int last = -100;
    for (int index = 0; index < levels.length; index++) {
      if (levels[index] < ONSET_DB || index - last < 8) continue;
      double before = index == 0 ? FLOOR_DB : Double.MAX_VALUE;
      for (int back = Math.max(0, index - 6); back < index; back++) before = Math.min(before, levels[back]);
      if (levels[index] - before < ONSET_RISE_DB) continue;
      double loudest = levels[index];
      for (int ahead = index; ahead < Math.min(levels.length, index + 4); ahead++) {
        loudest = Math.max(loudest, levels[ahead]);
      }
      onsets.add(new Onset(index * WINDOW_MS, loudest));
      last = index;
    }
  }

  private static double db(double amplitude) {
    return amplitude <= 0 ? FLOOR_DB : Math.max(FLOOR_DB, 20 * Math.log10(amplitude));
  }

  private static double round(double value) {
    return Math.round(value * 10) / 10.0;
  }

  public void describe(JsonObject json) {
    json.addProperty("durationMs", Math.round(wav.durationMs()));
    json.addProperty("sampleRate", wav.rate());
    json.addProperty("channels", wav.channels());
    json.addProperty("peakDb", round(peakDb));
    json.addProperty("rmsDb", round(rmsDb));
    json.addProperty("silent", peakDb < AUDIBLE_DB);
    int first = -1;
    int last = -1;
    for (int index = 0; index < levels.length; index++) {
      if (levels[index] < AUDIBLE_DB) continue;
      if (first < 0) first = index;
      last = index;
    }
    if (first >= 0) {
      json.addProperty("firstSoundMs", first * WINDOW_MS);
      json.addProperty("lastSoundMs", (last + 1) * WINDOW_MS);
    }
    JsonArray array = new JsonArray();
    for (Onset onset : onsets) {
      JsonObject entry = new JsonObject();
      entry.addProperty("ms", Math.round(onset.ms()));
      entry.addProperty("db", round(onset.db()));
      array.add(entry);
    }
    json.add("onsets", array);
  }

  private static final int BACKGROUND = 0x202225;
  private static final int PANEL = 0x2f3136;
  private static final int GRID = 0x40444b;
  private static final int GRID_STRONG = 0x72767d;
  private static final int WAVE = 0x43b581;
  private static final int MARKER = 0xfaa61a;
  private static final int ONSET = 0xf04747;
  private static final int TEXT = 0xdcddde;

  /** Waveform over time: grid line every tick (50 ms), labelled every 10 ticks; game sounds orange, onsets red. */
  public BufferedImage image(String title, List<Marker> markers) {
    double duration = Math.max(wav.durationMs(), 1);
    int plotWidth = (int) Math.clamp(Math.round(duration * 0.6), 500, 1500);
    double pxPerMs = plotWidth / duration;
    int labelRows = Math.min(6, markers.size());
    int margin = 8;
    int header = 14;
    int labels = labelRows * 10 + (labelRows > 0 ? 4 : 0);
    int plotHeight = 160;
    int plotTop = margin + header + labels;
    int width = plotWidth + 2 * margin;
    int height = plotTop + plotHeight + 14 + margin;
    BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
    Images.fill(image, 0, 0, width, height, BACKGROUND);
    Images.fill(image, margin, plotTop, plotWidth, plotHeight, PANEL);
    String head = BitmapFont.ascii(title + "  " + Math.round(duration) + " ms  peak " + round(peakDb) + " dB");
    BitmapFont.draw(image, head, margin, margin, 1, TEXT);

    boolean everyTick = pxPerMs * 50 >= 5;
    for (int tick = 0; tick * 50 <= duration; tick++) {
      boolean strong = tick % 10 == 0;
      if (!strong && !everyTick) continue;
      int x = margin + (int) Math.round(tick * 50 * pxPerMs);
      if (x >= margin + plotWidth) break;
      Images.fill(image, x, plotTop, 1, plotHeight, strong ? GRID_STRONG : GRID);
      if (strong) BitmapFont.draw(image, tick + "t", x, plotTop + plotHeight + 4, 1, TEXT);
    }

    int channels = wav.channels();
    short[] samples = wav.samples();
    int frames = wav.frames();
    int middle = plotTop + plotHeight / 2;
    // drawn relative to the loudest sample (the header names the real peak), so a quiet sound is still readable
    int full = Math.max(peak, 33);
    for (int column = 0; column < plotWidth; column++) {
      int from = (int) ((long) column * frames / plotWidth);
      int to = Math.max(from + 1, (int) ((long) (column + 1) * frames / plotWidth));
      int low = 0;
      int high = 0;
      for (int frame = from; frame < Math.min(to, frames); frame++) {
        for (int channel = 0; channel < channels; channel++) {
          int value = samples[frame * channels + channel];
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
      }
      int top = middle - high * (plotHeight / 2 - 2) / full;
      int bottom = middle - low * (plotHeight / 2 - 2) / full;
      Images.fill(image, margin + column, top, 1, bottom - top + 1, WAVE);
    }

    for (Onset onset : onsets) {
      Images.fill(image, margin + (int) Math.round(onset.ms() * pxPerMs), plotTop + plotHeight - 8, 2, 8, ONSET);
    }
    for (int index = 0; index < markers.size(); index++) {
      Marker marker = markers.get(index);
      int x = margin + (int) Math.clamp(Math.round(marker.ms() * pxPerMs), 0, plotWidth - 1);
      int row = labelRows == 0 ? 0 : index % labelRows;
      int labelY = margin + header + row * 10;
      Images.fill(image, x, labelRows == 0 ? plotTop : labelY, 1, plotTop - labelY + plotHeight / 4, MARKER);
      if (labelRows > 0) {
        String label = BitmapFont.ascii(marker.label());
        int labelX = Math.min(x + 3, width - margin - BitmapFont.width(label, 1));
        BitmapFont.draw(image, label, Math.max(margin, labelX), labelY, 1, MARKER);
      }
    }
    return image;
  }
}
