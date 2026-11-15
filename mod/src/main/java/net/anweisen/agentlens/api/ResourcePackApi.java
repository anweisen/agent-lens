package net.anweisen.agentlens.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Stream;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.http.Json;
import net.minecraft.client.Minecraft;
import net.minecraft.server.packs.repository.Pack;
import net.minecraft.server.packs.repository.PackRepository;

/** One local resource pack, copied into the game's resourcepacks folder and selected above everything else. */
final class ResourcePackApi {

  private static final String NAME = "agent-lens-local";
  private static final List<String> IDS = List.of("file/" + NAME, "file/" + NAME + ".zip");

  /** Source path and content fingerprint of the pack that is applied, to skip a reload that would change nothing. */
  private static String applied;

  private ResourcePackApi() {
  }

  static JsonElement resourcePack(JsonObject body) {
    Minecraft minecraft = Minecraft.getInstance();
    long timeoutMs = Json.integer(body, "timeoutMs", 120_000);
    long started = System.nanoTime();
    boolean changed;
    if (Json.bool(body, "clear", false) || !Json.bool(body, "enable", true)) {
      changed = ClientThread.call(() -> selected(minecraft) != null);
      ClientThread.run(() -> IDS.forEach(minecraft.getResourcePackRepository()::removePack));
      if (changed) reload(minecraft, null, timeoutMs);
      delete(minecraft);
      applied = null;
    } else {
      Path source = Path.of(Json.require(body, "path")).toAbsolutePath().normalize();
      boolean zip = Files.isRegularFile(source);
      if (zip && !source.getFileName().toString().toLowerCase(java.util.Locale.ROOT).endsWith(".zip")) {
        throw ApiException.bad("a pack file must be a .zip: " + source);
      }
      if (!zip && !Files.isRegularFile(source.resolve("pack.mcmeta"))) {
        throw new ApiException(404, "no resource pack at " + source + " (a directory with pack.mcmeta, or a .zip)");
      }
      String fingerprint = source + " " + fingerprint(source);
      String id = IDS.get(zip ? 1 : 0);
      changed = !(fingerprint.equals(applied) && id.equals(ClientThread.call(() -> selected(minecraft))));
      if (changed) {
        ClientThread.run(() -> IDS.forEach(minecraft.getResourcePackRepository()::removePack));
        delete(minecraft);
        copy(source, minecraft.getResourcePackDirectory().resolve(zip ? NAME + ".zip" : NAME));
        ClientThread.run(() -> {
          PackRepository repository = minecraft.getResourcePackRepository();
          repository.reload();
          if (!repository.addPack(id)) {
            throw new ApiException(500, "the client does not list the copied pack, available: "
              + repository.getAvailableIds());
          }
        });
        reload(minecraft, id, timeoutMs);
        applied = fingerprint;
      }
    }
    ClientThread.awaitFrames(2);
    long reloadMs = (System.nanoTime() - started) / 1_000_000;
    return ClientThread.call(() -> {
      JsonObject json = new JsonObject();
      String id = selected(minecraft);
      json.addProperty("pack", id);
      json.addProperty("source", id == null || applied == null ? null : applied.substring(0, applied.lastIndexOf(' ')));
      Pack pack = id == null ? null : minecraft.getResourcePackRepository().getPack(id);
      if (pack != null) json.addProperty("compatible", pack.getCompatibility().isCompatible());
      json.addProperty("reloaded", changed);
      json.addProperty("ms", reloadMs);
      JsonArray selected = new JsonArray();
      minecraft.getResourcePackRepository().getSelectedIds().forEach(selected::add);
      json.add("selected", selected);
      return json;
    });
  }

  private static String selected(Minecraft minecraft) {
    for (String id : IDS) if (minecraft.getResourcePackRepository().getSelectedIds().contains(id)) return id;
    return null;
  }

  /** Returns when the reload overlay is gone. The game deselects a pack that fails to load. */
  private static void reload(Minecraft minecraft, String id, long timeoutMs) {
    CompletableFuture<?> reload = ClientThread.call(() -> (CompletableFuture<?>) minecraft.reloadResourcePacks());
    ClientThread.awaitUntil(() -> minecraft.gui.overlay() == null
      && (reload.isDone() || id != null && !id.equals(selected(minecraft))), timeoutMs, "the resource reload");
    if (id != null && !id.equals(ClientThread.call(() -> selected(minecraft)))) {
      throw new ApiException(500, "the resource reload failed with this pack and the game dropped it, see the log");
    }
  }

  private static String fingerprint(Path source) {
    try (Stream<Path> files = Files.walk(source)) {
      long[] sum = new long[3];
      files.filter(Files::isRegularFile).forEach(file -> {
        try {
          sum[0]++;
          sum[1] += Files.size(file);
          sum[2] = Math.max(sum[2], Files.getLastModifiedTime(file).toMillis());
        } catch (IOException error) {
          throw new UncheckedIOException(error);
        }
      });
      return sum[0] + "/" + sum[1] + "/" + sum[2];
    } catch (IOException | UncheckedIOException error) {
      throw new ApiException(500, "cannot read " + source + ": " + error.getMessage());
    }
  }

  private static void copy(Path source, Path target) {
    try (Stream<Path> files = Files.walk(source)) {
      for (Path file : (Iterable<Path>) files::iterator) {
        Path to = target.resolve(source.relativize(file).toString());
        if (Files.isDirectory(file)) Files.createDirectories(to);
        else {
          Files.createDirectories(to.getParent());
          Files.copy(file, to, StandardCopyOption.REPLACE_EXISTING);
        }
      }
    } catch (IOException error) {
      throw new ApiException(500, "cannot copy the pack to " + target + ": " + error.getMessage());
    }
  }

  private static void delete(Minecraft minecraft) {
    for (String name : List.of(NAME, NAME + ".zip")) {
      Path target = minecraft.getResourcePackDirectory().resolve(name);
      if (!Files.exists(target)) continue;
      try (Stream<Path> files = Files.walk(target)) {
        for (Path file : (Iterable<Path>) files.sorted(Comparator.reverseOrder())::iterator) Files.delete(file);
      } catch (IOException error) {
        throw new ApiException(500, "cannot remove " + target + ": " + error.getMessage());
      }
    }
  }
}
