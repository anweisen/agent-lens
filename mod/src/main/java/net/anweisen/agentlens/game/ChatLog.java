package net.anweisen.agentlens.game;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/** Plain text of every message the chat HUD received, with a running sequence number for /wait. */
public final class ChatLog {

  public record Line(long seq, String text) {
  }

  private static final ArrayDeque<Line> LINES = new ArrayDeque<>();
  private static long seq;

  private ChatLog() {
  }

  public static synchronized void add(String text) {
    LINES.addLast(new Line(++seq, text));
    while (LINES.size() > 200) LINES.removeFirst();
  }

  public static synchronized long seq() {
    return seq;
  }

  public static synchronized List<Line> last(int count) {
    List<Line> all = new ArrayList<>(LINES);
    return all.subList(Math.max(0, all.size() - count), all.size());
  }

  public static synchronized List<Line> since(long after) {
    List<Line> result = new ArrayList<>();
    for (Line line : LINES) if (line.seq > after) result.add(line);
    return result;
  }

  public static synchronized void clear() {
    LINES.clear();
  }
}
