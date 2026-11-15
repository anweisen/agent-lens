package net.anweisen.agentlens.http;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;
import net.anweisen.agentlens.core.Lens;

/** Loopback-only JSON over HTTP. A handler may block; a failing handler only fails its own request. */
public final class ApiServer {

  public interface Handler {
    JsonElement handle(JsonObject body) throws Exception;
  }

  private record Route(String method, boolean exclusive, Handler handler) {
  }

  private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();

  private final HttpServer http;
  private final Map<String, Route> routes = new TreeMap<>();
  // requests that change or depend on scene state run one at a time, so two callers cannot interleave a shot
  private final ReentrantLock exclusive = new ReentrantLock(true);

  public ApiServer(int port) throws IOException {
    http = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 16);
    AtomicInteger counter = new AtomicInteger();
    ExecutorService executor = Executors.newFixedThreadPool(6, task -> {
      Thread thread = new Thread(task, "lens-http-" + counter.incrementAndGet());
      thread.setDaemon(true);
      return thread;
    });
    http.setExecutor(executor);
    http.createContext("/", this::dispatch);
  }

  public void start() {
    // the JDK's dispatcher thread inherits daemon status from its creator; a non-daemon one keeps the JVM alive
    // after the game has closed, which trips Minecraft's shutdown watchdog
    Thread starter = new Thread(http::start, "lens-http-start");
    starter.setDaemon(true);
    starter.start();
    try {
      starter.join();
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }

  public void stop() {
    http.stop(0);
  }

  public int port() {
    return http.getAddress().getPort();
  }

  public void get(String path, Handler handler) {
    routes.put(path, new Route("GET", false, handler));
  }

  public void post(String path, Handler handler) {
    routes.put(path, new Route("POST", true, handler));
  }

  /** POST that may run while another request holds the scene (quit, status-like calls). */
  public void postShared(String path, Handler handler) {
    routes.put(path, new Route("POST", false, handler));
  }

  private void dispatch(HttpExchange exchange) throws IOException {
    Lens.requestBegin();
    int status = 200;
    JsonElement result;
    try {
      String path = exchange.getRequestURI().getPath();
      if (path.length() > 1 && path.endsWith("/")) path = path.substring(0, path.length() - 1);
      Route route = routes.get(path);
      if (route == null) throw new ApiException(404, "unknown path " + path + ", known: " + routes.keySet());
      String method = exchange.getRequestMethod();
      if (!method.equals(route.method) && !(method.equals("POST") && route.method.equals("GET"))) {
        throw new ApiException(405, path + " expects " + route.method);
      }
      String text = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8).trim();
      JsonObject body = new JsonObject();
      if (!text.isEmpty()) {
        JsonElement parsed;
        try {
          parsed = JsonParser.parseString(text);
        } catch (RuntimeException error) {
          throw ApiException.bad("request body is not valid JSON: " + error.getMessage());
        }
        if (!parsed.isJsonObject()) throw ApiException.bad("request body must be a JSON object");
        body = parsed.getAsJsonObject();
      }
      if (route.exclusive) {
        exclusive.lock();
        try {
          result = route.handler.handle(body);
        } finally {
          exclusive.unlock();
        }
      } else {
        result = route.handler.handle(body);
      }
      if (result == null) result = new JsonObject();
    } catch (ApiException error) {
      status = error.status();
      result = error(error.getMessage());
    } catch (Throwable error) {
      Lens.LOG.warn("request {} failed", exchange.getRequestURI(), error);
      status = error instanceof IllegalArgumentException || error instanceof ClassCastException
        || error instanceof UnsupportedOperationException || error instanceof IllegalStateException
        && error.getMessage() != null && error.getMessage().startsWith("Not a JSON") ? 400 : 500;
      result = error(error.getClass().getSimpleName() + ": " + error.getMessage());
    }
    try {
      byte[] bytes = (GSON.toJson(result) + "\n").getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
      exchange.sendResponseHeaders(status, bytes.length);
      try (OutputStream out = exchange.getResponseBody()) {
        out.write(bytes);
      }
    } catch (IOException closed) {
      // the caller went away, nothing to report to
    } finally {
      exchange.close();
      Lens.requestEnd();
    }
  }

  private static JsonObject error(String message) {
    JsonObject json = new JsonObject();
    json.addProperty("error", message);
    return json;
  }
}
