package net.anweisen.agentlens.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Map;
import java.util.UUID;
import net.anweisen.agentlens.capture.Regions;
import net.anweisen.agentlens.game.ChatLog;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.http.Json;
import net.anweisen.agentlens.util.Rect;
import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Hud;
import net.minecraft.client.gui.components.BossHealthOverlay;
import net.minecraft.client.gui.components.LerpingBossEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.world.scores.DisplaySlot;
import net.minecraft.world.scores.Objective;
import net.minecraft.world.scores.PlayerTeam;
import net.minecraft.world.scores.Scoreboard;

final class HudApi {

  private HudApi() {
  }

  private static JsonObject section(String region) {
    JsonObject json = new JsonObject();
    Rect now = Regions.current().get(region);
    json.addProperty("visible", now != null);
    Regions.Seen seen = Regions.lastSeen(region);
    json.add("rect", now != null ? now.json() : seen == null ? null : seen.rect().json());
    return json;
  }

  private static String text(Component component) {
    return component == null ? null : component.getString();
  }

  static JsonElement hud(JsonObject body) {
    int lines = Math.clamp(Json.integer(body, "lines", 20), 1, 200);
    ClientThread.awaitFrames(1);
    return ClientThread.call(() -> {
      Minecraft minecraft = Minecraft.getInstance();
      Hud hud = minecraft.gui.hud;
      JsonObject json = new JsonObject();
      json.addProperty("hidden", hud.isHidden());

      JsonObject chat = section("chat");
      JsonArray chatLines = new JsonArray();
      for (ChatLog.Line line : ChatLog.last(lines)) chatLines.add(line.text());
      chat.add("lines", chatLines);
      json.add("chat", chat);

      JsonObject actionbar = section("actionbar");
      int overlayTime = Reflect.<Integer>get(Hud.class, hud, "overlayMessageTime");
      actionbar.addProperty("text", overlayTime > 0 ? text(Reflect.get(Hud.class, hud, "overlayMessageString")) : null);
      actionbar.addProperty("ticksLeft", overlayTime);
      json.add("actionbar", actionbar);

      JsonObject title = section("title");
      int titleTime = Reflect.<Integer>get(Hud.class, hud, "titleTime");
      title.addProperty("title", titleTime > 0 ? text(Reflect.get(Hud.class, hud, "title")) : null);
      title.addProperty("subtitle", titleTime > 0 ? text(Reflect.get(Hud.class, hud, "subtitle")) : null);
      title.addProperty("ticksLeft", titleTime);
      json.add("title", title);

      JsonObject bossbar = section("bossbar");
      JsonArray bars = new JsonArray();
      Map<UUID, LerpingBossEvent> events = Reflect.get(BossHealthOverlay.class, hud.getBossOverlay(), "events");
      for (LerpingBossEvent event : events.values()) {
        JsonObject bar = new JsonObject();
        bar.addProperty("name", text(event.getName()));
        bar.addProperty("progress", event.getProgress());
        bar.addProperty("color", event.getColor().getName());
        bars.add(bar);
      }
      bossbar.add("bars", bars);
      json.add("bossbar", bossbar);

      JsonObject sidebar = section("sidebar");
      JsonArray sidebarLines = new JsonArray();
      String sidebarTitle = null;
      if (minecraft.level != null) {
        Scoreboard scoreboard = minecraft.level.getScoreboard();
        Objective objective = scoreboard.getDisplayObjective(DisplaySlot.SIDEBAR);
        if (objective != null) {
          sidebarTitle = text(objective.getDisplayName());
          scoreboard.listPlayerScores(objective).stream().filter(score -> !score.isHidden())
            .sorted((a, b) -> Integer.compare(b.value(), a.value())).limit(15).forEach(score -> {
              JsonObject line = new JsonObject();
              PlayerTeam team = scoreboard.getPlayersTeam(score.owner());
              line.addProperty("name", text(PlayerTeam.formatNameForTeam(team, score.ownerName())));
              line.addProperty("score", score.value());
              sidebarLines.add(line);
            });
        }
      }
      sidebar.addProperty("title", sidebarTitle);
      sidebar.add("lines", sidebarLines);
      json.add("sidebar", sidebar);

      json.add("hotbar", section("hotbar"));
      if (minecraft.player != null) {
        json.getAsJsonObject("hotbar").addProperty("selected", minecraft.player.getInventory().getSelectedSlot());
      }
      return json;
    });
  }
}
