package net.anweisen.agentlens.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import net.anweisen.agentlens.audio.Recorder;
import net.anweisen.agentlens.capture.Images;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.http.Json;

final class RecordApi {

  private RecordApi() {
  }

  static JsonElement record(JsonObject body) {
    String action = Json.require(body, "action");
    if (action.equals("stop")) return Recorder.stop();
    if (!action.equals("start")) throw ApiException.bad("action must be start or stop");
    String out = Json.require(body, "out");
    if (!out.toLowerCase(java.util.Locale.ROOT).endsWith(".wav")) throw ApiException.bad("\"out\" must end in .wav");
    JsonElement video = Json.has(body, "video") ? body.get("video") : null;
    if (video != null && video.isJsonPrimitive() && video.getAsJsonPrimitive().isBoolean()) {
      video = video.getAsBoolean() ? new JsonPrimitive("full") : null;
    }
    int interval = Json.integer(body, "intervalTicks", 2);
    if (interval < 1 || interval > 200) throw ApiException.bad("intervalTicks must be 1-200");
    return Recorder.start(Images.outPath(out), video, interval, Math.max(0, Json.integer(body, "pad", 0)));
  }
}
