package net.anweisen.agentlens.audio;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.audio.Library;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.IntBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;
import net.anweisen.agentlens.capture.Capture;
import net.anweisen.agentlens.capture.Images;
import net.anweisen.agentlens.core.Lens;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.game.Ticks;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.http.Json;
import net.anweisen.agentlens.util.Rect;
import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.sounds.SoundInstance;
import net.minecraft.client.sounds.SoundEngine;
import net.minecraft.client.sounds.SoundManager;
import net.minecraft.sounds.SoundSource;
import org.lwjgl.openal.ALC10;
import org.lwjgl.openal.SOFTDeviceClock;
import org.lwjgl.openal.SOFTReopenDevice;

/**
 * Records what the game mixes. The launcher starts the client on OpenAL Soft's wave writer, whose output file is a
 * symlink to /dev/null. A recording points the link at a real file and reopens the device (which starts a new
 * file); stopping points it back. Positions in the recording come from the device's sample clock, so a sound the
 * game starts is placed to within one mixer period (about 5 ms), however long the API calls around it take.
 */
public final class Recorder {

  private static final long MAX_MS = 120_000;
  private static final int MAX_FRAMES = 600;
  private static final Path NOWHERE = Path.of("/dev/null");

  private static final class Session {
    Path out;
    Path raw;
    long device;
    int rate;
    long clock0;
    long tick0;
    final List<JsonObject> sounds = new ArrayList<>();
    final List<Analysis.Marker> markers = new ArrayList<>();
    JsonElement region;
    int pad;
    int intervalTicks;
    Path framesDir;
    Rect rect;
    final List<Long> frameMs = new ArrayList<>();
    String frameError;
    Thread worker;
    volatile boolean stop;

    double ms() {
      return (SOFTDeviceClock.alcGetInteger64vSOFT(device, SOFTDeviceClock.ALC_DEVICE_CLOCK_SOFT) - clock0) / 1e6;
    }
  }

  private static volatile Session session;
  private static boolean listening;

  private Recorder() {
  }

  private static Path link() {
    String file = System.getProperty("agentlens.audioFile");
    if (file == null || file.isBlank()) {
      throw ApiException.conflict("this client was started without the recording audio backend "
        + "(-Dagentlens.audioFile, ALSOFT_DRIVERS=wave): restart it with the current launcher");
    }
    return Path.of(file);
  }

  private static void point(Path link, Path target) throws IOException {
    Path tmp = link.resolveSibling(link.getFileName() + ".new");
    Files.deleteIfExists(tmp);
    Files.createSymbolicLink(tmp, target);
    Files.move(tmp, link, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
  }

  private static boolean reopen(long device) {
    return SOFTReopenDevice.alcReopenDeviceSOFT(device, (ByteBuffer) null, (IntBuffer) null);
  }

  /** Client thread. */
  private static long device(Minecraft minecraft) {
    SoundManager manager = minecraft.getSoundManager();
    SoundEngine engine = Reflect.get(SoundManager.class, manager, "soundEngine");
    if (!Reflect.<Boolean>get(SoundEngine.class, engine, "loaded")) {
      throw ApiException.conflict("the sound engine is not loaded");
    }
    Library library = Reflect.get(SoundEngine.class, engine, "library");
    String name = String.valueOf(library.currentDeviceName());
    if (!name.contains("Wave File Writer")) {
      throw ApiException.conflict("the sound device is \"" + name + "\", not OpenAL Soft's wave writer: the client "
        + "must run with ALSOFT_DRIVERS=wave (the launcher default)");
    }
    if (minecraft.options.getSoundSourceVolume(SoundSource.MASTER) <= 0) {
      throw ApiException.conflict("the master volume is 0, nothing would be recorded");
    }
    if (!listening) {
      manager.addListener((instance, events, range) -> heard(instance));
      listening = true;
    }
    return Reflect.<Long>get(Library.class, library, "currentDevice");
  }

  /** Client thread: the game starts a sound. */
  private static void heard(SoundInstance instance) {
    Session current = session;
    if (current == null) return;
    try {
      // started silently (music with its category at 0): nothing to hear, nothing to mark
      if (Minecraft.getInstance().options.getFinalSoundSourceVolume(instance.getSource()) <= 0) return;
      double ms = current.ms();
      JsonObject json = new JsonObject();
      json.addProperty("ms", Math.round(ms));
      json.addProperty("tick", Ticks.client() - current.tick0);
      json.addProperty("id", instance.getIdentifier().toString());
      if (instance.getSound() != null) json.addProperty("file", instance.getSound().getLocation().toString());
      json.addProperty("source", instance.getSource().getName());
      json.addProperty("volume", Math.round(instance.getVolume() * 1000) / 1000.0);
      json.addProperty("pitch", Math.round(instance.getPitch() * 1000) / 1000.0);
      if (instance.isRelative()) json.addProperty("relative", true);
      else json.add("pos", Json.array(instance.getX(), instance.getY(), instance.getZ()));
      synchronized (current.sounds) {
        current.sounds.add(json);
        float pitch = instance.getPitch();
        String label = instance.getIdentifier().getPath();
        current.markers.add(new Analysis.Marker(ms, pitch == 1 ? label : label + " x" + json.get("pitch")));
      }
    } catch (RuntimeException error) {
      Lens.LOG.warn("cannot describe a sound", error);
    }
  }

  public static synchronized JsonObject start(Path out, JsonElement video, int intervalTicks, int pad) {
    if (session != null) throw ApiException.conflict("a recording is running: " + session.out + " (record stop)");
    Path link = link();
    Session next = new Session();
    next.out = out;
    next.raw = link.resolveSibling(link.getFileName() + ".rec");
    next.device = ClientThread.call(() -> device(Minecraft.getInstance()));
    next.rate = ALC10.alcGetInteger(next.device, ALC10.ALC_FREQUENCY);
    if (video != null) {
      next.region = video;
      next.pad = pad;
      next.intervalTicks = intervalTicks;
      String name = out.getFileName().toString();
      // beside the raw recording, which the launcher keeps in memory-backed state: the frames only live until
      // the CLI has made the video
      next.framesDir = link.resolveSibling(name.replaceFirst("\\.[^.]+$", "") + ".frames");
      deleteTree(next.framesDir);
    }
    try {
      point(link, next.raw);
      if (!reopen(next.device)) throw new IOException("OpenAL refused to reopen the device");
    } catch (IOException error) {
      silence(link, next.device);
      throw new ApiException(500, "cannot start recording: " + error.getMessage());
    }
    next.clock0 = SOFTDeviceClock.alcGetInteger64vSOFT(next.device, SOFTDeviceClock.ALC_DEVICE_CLOCK_SOFT);
    next.tick0 = ClientThread.call(Ticks::client);
    // counts as a running request: full frame rate, no idle shutdown
    Lens.requestBegin();
    session = next;
    next.worker = new Thread(() -> work(next), "lens-record");
    next.worker.setDaemon(true);
    next.worker.start();
    JsonObject json = new JsonObject();
    json.addProperty("recording", true);
    json.addProperty("out", out.toString());
    json.addProperty("maxMs", MAX_MS);
    return json;
  }

  private static void silence(Path link, long device) {
    try {
      point(link, NOWHERE);
    } catch (IOException error) {
      Lens.LOG.error("cannot point {} back to /dev/null", link, error);
    }
    reopen(device);
  }

  /** Grabs the video frames at exact tick offsets, and ends a recording nobody stopped. */
  private static void work(Session current) {
    long began = System.nanoTime();
    int index = 0;
    while (!current.stop && System.nanoTime() - began < MAX_MS * 1_000_000L) {
      try {
        if (current.region == null || current.frameError != null || index >= MAX_FRAMES) {
          Thread.sleep(20);
          continue;
        }
        long target = current.tick0 + (long) index * current.intervalTicks;
        ClientThread.awaitUntil(() -> current.stop || Ticks.client() >= target, 10_000, "client tick " + target);
        if (current.stop) break;
        Capture.Shot shot = current.rect == null ? Capture.shot(current.region, current.pad)
          : Capture.shot(current.rect.json(), 0);
        long ms = Math.round(current.ms());
        if (current.rect == null) current.rect = shot.rect();
        Images.writePng(Images.crop(shot.frame(), shot.rect()),
          current.framesDir.resolve(String.format("frame-%04d.png", index)), false);
        current.frameMs.add(ms);
        index++;
      } catch (InterruptedException interrupted) {
        return;
      } catch (RuntimeException error) {
        current.frameError = String.valueOf(error.getMessage());
      }
    }
    if (!current.stop) {
      Lens.LOG.warn("recording {} was not stopped within {} ms, discarded", current.out, MAX_MS);
      synchronized (Recorder.class) {
        if (session == current) end(current);
      }
    }
  }

  /** Closes the file and frees the session; returns the recorded samples from the start mark on. */
  private static Wav end(Session current) {
    long clock1 = SOFTDeviceClock.alcGetInteger64vSOFT(current.device, SOFTDeviceClock.ALC_DEVICE_CLOCK_SOFT);
    session = null;
    Lens.requestEnd();
    silence(link(), current.device);
    try {
      Wav wav = Wav.read(current.raw);
      // the file starts with the reopen, where the start mark was read; the mixer ran on a little after the end mark
      int wanted = (int) Math.round((clock1 - current.clock0) * (double) wav.rate() / 1e9);
      return wav.slice(0, wanted);
    } catch (IOException error) {
      throw new ApiException(500, "cannot read the recording: " + error.getMessage());
    } finally {
      try {
        Files.deleteIfExists(current.raw);
      } catch (IOException ignored) {
      }
    }
  }

  public static synchronized JsonObject stop() {
    Session current = session;
    if (current == null) throw ApiException.conflict("no recording is running (record start --out <file.wav>)");
    current.stop = true;
    try {
      current.worker.join(40_000);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
    long ticks = ClientThread.call(Ticks::client) - current.tick0;
    Wav wav = end(current);
    Analysis analysis = new Analysis(wav);
    JsonObject json = new JsonObject();
    try {
      wav.write(current.out);
    } catch (IOException error) {
      throw new ApiException(500, "cannot write " + current.out + ": " + error.getMessage());
    }
    String name = current.out.getFileName().toString().replaceFirst("\\.[^.]+$", "");
    Path image = current.out.resolveSibling(name + ".png");
    List<Analysis.Marker> markers;
    JsonArray sounds = new JsonArray();
    synchronized (current.sounds) {
      markers = List.copyOf(current.markers);
      current.sounds.forEach(sounds::add);
    }
    Images.writePng(analysis.image(name, markers), image);
    json.addProperty("file", current.out.toString());
    json.addProperty("image", image.toString());
    json.addProperty("ticks", ticks);
    analysis.describe(json);
    json.add("sounds", sounds);
    if (current.region != null) {
      JsonObject frames = new JsonObject();
      frames.addProperty("dir", current.framesDir.toString());
      frames.addProperty("count", current.frameMs.size());
      frames.addProperty("intervalTicks", current.intervalTicks);
      if (current.rect != null) frames.add("rect", current.rect.json());
      JsonArray times = new JsonArray();
      current.frameMs.forEach(times::add);
      frames.add("ms", times);
      if (current.frameError != null) frames.addProperty("error", current.frameError);
      json.add("frames", frames);
    }
    return json;
  }

  private static void deleteTree(Path dir) {
    if (!Files.isDirectory(dir)) return;
    try (Stream<Path> files = Files.walk(dir)) {
      files.sorted(Comparator.reverseOrder()).forEach(file -> file.toFile().delete());
    } catch (IOException ignored) {
    }
  }
}
