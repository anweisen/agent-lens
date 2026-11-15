package net.anweisen.agentlens.core;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import net.anweisen.agentlens.api.Api;
import net.anweisen.agentlens.game.Determinism;
import net.anweisen.agentlens.http.ApiServer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Process-wide state of the mod: configuration from the -Dagentlens.* properties, startup, the state file the CLI
 * reads, and the idle timer that stops the client.
 */
public final class Lens {

  public static final Logger LOG = LoggerFactory.getLogger("lens");

  private static String version = "dev";
  private static Path stateFile;
  private static double idleMinutes = 10;
  private static int idleFps = 10;
  private static int busyFps = 60;
  private static Set<String> allow = Set.of();
  private static ApiServer server;

  private static volatile boolean ready;
  private static volatile boolean stopping;
  private static final AtomicInteger ACTIVE = new AtomicInteger();
  private static volatile long lastRequestNanos = System.nanoTime();

  private Lens() {
  }

  public static void init() {
    try {
      version = FabricLoader.getInstance().getModContainer("lens")
        .map(mod -> mod.getMetadata().getVersion().getFriendlyString()).orElse("dev");
      String state = System.getProperty("agentlens.stateFile");
      stateFile = state == null || state.isBlank() ? null : Path.of(state);
      idleMinutes = Double.parseDouble(System.getProperty("agentlens.idleMinutes", "10"));
      idleFps = Integer.getInteger("agentlens.idleFps", 10);
      busyFps = Integer.getInteger("agentlens.busyFps", 60);
      allow = Stream.of(System.getProperty("agentlens.allow", "").split(","))
        .map(String::trim).filter(entry -> !entry.isEmpty()).collect(Collectors.toUnmodifiableSet());
      server = new ApiServer(Integer.getInteger("agentlens.port", 0));
      Api.register(server);
      server.start();
      Thread watchdog = new Thread(Lens::watchIdle, "lens-idle");
      watchdog.setDaemon(true);
      watchdog.start();
      Runtime.getRuntime().addShutdownHook(new Thread(Lens::deleteStateFile, "lens-shutdown"));
      LOG.info("lens {} listening on 127.0.0.1:{}, idle shutdown after {} min, {} allowed server(s)", version,
        server.port(), idleMinutes, allow.size());
    } catch (Throwable error) {
      LOG.error("lens failed to start, the client runs without the API", error);
    }
  }

  public static String version() {
    return version;
  }

  /** Servers /connect may join, as host:port. */
  public static Set<String> allow() {
    return allow;
  }

  /** True once the title screen is up and the state file is written. */
  public static boolean ready() {
    return ready;
  }

  /** Client thread, after every completed frame: announces the API once the game has finished loading. */
  public static void frameEnd() {
    if (ready || server == null) return;
    Minecraft minecraft = Minecraft.getInstance();
    if (minecraft.isGameLoadFinished() && minecraft.gui.overlay() == null && minecraft.gui.screen() != null) {
      Determinism.applyOptions(minecraft);
      ready = true;
      lastRequestNanos = System.nanoTime();
      writeStateFile();
      LOG.info("lens ready");
    }
  }

  // ---- request bookkeeping -------------------------------------------------------------------------------------

  public static void requestBegin() {
    ACTIVE.incrementAndGet();
    lastRequestNanos = System.nanoTime();
  }

  public static void requestEnd() {
    lastRequestNanos = System.nanoTime();
    ACTIVE.decrementAndGet();
  }

  public static long idleSecondsLeft() {
    if (idleMinutes <= 0) return -1;
    if (ACTIVE.get() > 0) return Math.round(idleMinutes * 60);
    long idleNanos = System.nanoTime() - lastRequestNanos;
    return Math.max(0, Math.round(idleMinutes * 60 - idleNanos / 1e9));
  }

  private static void watchIdle() {
    while (!stopping) {
      try {
        Thread.sleep(1000);
      } catch (InterruptedException interrupted) {
        return;
      }
      if (idleMinutes > 0 && idleSecondsLeft() == 0) {
        LOG.info("no API request for {} min, stopping the client", idleMinutes);
        quit();
        return;
      }
    }
  }

  public static void quit() {
    stopping = true;
    deleteStateFile();
    Minecraft minecraft = Minecraft.getInstance();
    minecraft.execute(minecraft::stop);
  }

  private static void deleteStateFile() {
    try {
      if (stateFile != null) Files.deleteIfExists(stateFile);
    } catch (IOException ignored) {
    }
  }

  private static void writeStateFile() {
    if (stateFile == null) return;
    JsonObject json = new JsonObject();
    json.addProperty("port", server.port());
    json.addProperty("pid", ProcessHandle.current().pid());
    json.addProperty("version", version);
    try {
      Files.createDirectories(stateFile.getParent());
      Path tmp = stateFile.resolveSibling(stateFile.getFileName() + ".tmp");
      Files.writeString(tmp, json + "\n", StandardCharsets.UTF_8);
      Files.move(tmp, stateFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (IOException error) {
      LOG.error("cannot write state file {}", stateFile, error);
    }
  }

  /** Frame limit while nothing is asked of the client; 0 keeps the game's own value. */
  public static int fpsLimit() {
    if (!ready) return 0;
    boolean busy = ACTIVE.get() > 0 || System.nanoTime() - lastRequestNanos < 2_000_000_000L;
    return busy ? busyFps : idleFps;
  }
}
