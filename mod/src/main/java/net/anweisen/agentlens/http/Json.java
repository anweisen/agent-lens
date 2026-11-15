package net.anweisen.agentlens.http;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

public final class Json {

  private Json() {
  }

  public static boolean has(JsonObject body, String key) {
    return body.has(key) && !body.get(key).isJsonNull();
  }

  public static String string(JsonObject body, String key, String fallback) {
    if (!has(body, key)) return fallback;
    JsonElement element = body.get(key);
    if (!element.isJsonPrimitive()) throw ApiException.bad("\"" + key + "\" must be a string");
    return element.getAsString();
  }

  public static String require(JsonObject body, String key) {
    String value = string(body, key, null);
    if (value == null) throw ApiException.bad("\"" + key + "\" is required");
    return value;
  }

  public static int integer(JsonObject body, String key, int fallback) {
    if (!has(body, key)) return fallback;
    try {
      return body.get(key).getAsInt();
    } catch (RuntimeException error) {
      throw ApiException.bad("\"" + key + "\" must be an integer");
    }
  }

  public static double number(JsonObject body, String key, double fallback) {
    if (!has(body, key)) return fallback;
    try {
      return body.get(key).getAsDouble();
    } catch (RuntimeException error) {
      throw ApiException.bad("\"" + key + "\" must be a number");
    }
  }

  public static boolean bool(JsonObject body, String key, boolean fallback) {
    if (!has(body, key)) return fallback;
    try {
      return body.get(key).getAsBoolean();
    } catch (RuntimeException error) {
      throw ApiException.bad("\"" + key + "\" must be true or false");
    }
  }

  public static JsonObject object(JsonObject body, String key) {
    if (!has(body, key)) return null;
    if (!body.get(key).isJsonObject()) throw ApiException.bad("\"" + key + "\" must be an object");
    return body.getAsJsonObject(key);
  }

  public static double[] vector(JsonObject body, String key) {
    if (!has(body, key)) return null;
    JsonElement element = body.get(key);
    if (!element.isJsonArray() || element.getAsJsonArray().size() != 3) {
      throw ApiException.bad("\"" + key + "\" must be [x, y, z]");
    }
    JsonArray array = element.getAsJsonArray();
    return new double[] {array.get(0).getAsDouble(), array.get(1).getAsDouble(), array.get(2).getAsDouble()};
  }

  public static JsonArray array(double... values) {
    JsonArray array = new JsonArray();
    for (double value : values) array.add(Math.round(value * 1000) / 1000.0);
    return array;
  }
}
