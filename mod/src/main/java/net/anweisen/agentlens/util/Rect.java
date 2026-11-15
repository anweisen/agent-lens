package net.anweisen.agentlens.util;

import com.google.gson.JsonObject;

/** Rectangle in framebuffer pixels unless stated otherwise. */
public record Rect(int x, int y, int w, int h) {

  public int right() {
    return x + w;
  }

  public int bottom() {
    return y + h;
  }

  public boolean isEmpty() {
    return w <= 0 || h <= 0;
  }

  public Rect union(Rect other) {
    if (other == null) return this;
    int left = Math.min(x, other.x);
    int top = Math.min(y, other.y);
    return new Rect(left, top, Math.max(right(), other.right()) - left, Math.max(bottom(), other.bottom()) - top);
  }

  public Rect pad(int pad) {
    return new Rect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
  }

  public Rect scale(int factor) {
    return new Rect(x * factor, y * factor, w * factor, h * factor);
  }

  public Rect clamp(int width, int height) {
    int left = Math.clamp(x, 0, width);
    int top = Math.clamp(y, 0, height);
    return new Rect(left, top, Math.clamp(right(), left, width) - left, Math.clamp(bottom(), top, height) - top);
  }

  public JsonObject json() {
    JsonObject json = new JsonObject();
    json.addProperty("x", x);
    json.addProperty("y", y);
    json.addProperty("w", w);
    json.addProperty("h", h);
    return json;
  }
}
