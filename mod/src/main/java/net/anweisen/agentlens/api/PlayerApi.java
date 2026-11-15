package net.anweisen.agentlens.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Locale;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.game.Readiness;
import net.anweisen.agentlens.game.Scene;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.http.Json;
import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

final class PlayerApi {

  private static Integer originalFov;

  private PlayerApi() {
  }

  private static LocalPlayer player(Minecraft minecraft) {
    if (minecraft.player == null || minecraft.level == null) throw ApiException.conflict("not in a world");
    return minecraft.player;
  }

  static JsonElement look(JsonObject body) {
    Minecraft minecraft = Minecraft.getInstance();
    double[] at = Json.vector(body, "at");
    if (at == null && !(Json.has(body, "yaw") && Json.has(body, "pitch"))) {
      throw ApiException.bad("expected {yaw, pitch} or {at: [x, y, z]}");
    }
    ClientThread.run(() -> {
      LocalPlayer player = player(minecraft);
      if (at != null) {
        player.lookAt(EntityAnchorArgument.Anchor.EYES, new Vec3(at[0], at[1], at[2]));
      } else {
        player.setYRot((float) Json.number(body, "yaw", 0));
        player.setXRot((float) Math.clamp(Json.number(body, "pitch", 0), -90, 90));
      }
      // no interpolation from the previous orientation, body and head follow at once
      player.yRotO = player.getYRot();
      player.xRotO = player.getXRot();
      player.setYHeadRot(player.getYRot());
      player.setYBodyRot(player.getYRot());
      player.yHeadRotO = player.getYRot();
      player.yBodyRotO = player.getYRot();
    });
    Readiness.awaitTicks(2);
    ClientThread.awaitFrames(1);
    return ClientThread.call(() -> {
      JsonObject json = new JsonObject();
      json.addProperty("yaw", minecraft.player.getYRot());
      json.addProperty("pitch", minecraft.player.getXRot());
      json.add("target", target(minecraft));
      return json;
    });
  }

  private static JsonElement target(Minecraft minecraft) {
    HitResult hit = minecraft.hitResult;
    if (hit == null) return null;
    JsonObject json = new JsonObject();
    json.addProperty("type", hit.getType().name().toLowerCase(Locale.ROOT));
    Vec3 pos = hit.getLocation();
    json.add("pos", Json.array(pos.x, pos.y, pos.z));
    return json;
  }

  static JsonElement camera(JsonObject body) {
    Minecraft minecraft = Minecraft.getInstance();
    JsonObject fixed = Json.object(body, "fixed");
    ClientThread.run(() -> {
      if (originalFov == null) originalFov = minecraft.options.fov().get();
      if (Json.bool(body, "reset", false)) {
        minecraft.options.setCameraType(CameraType.FIRST_PERSON);
        minecraft.options.fov().set(originalFov);
        Scene.fixedCamera = null;
        Scene.hideHand = false;
        Scene.hidePlayer = false;
        if (minecraft.gui.hud.isHidden()) minecraft.gui.hud.toggle();
      }
      if (Json.has(body, "mode")) {
        minecraft.options.setCameraType(switch (Json.string(body, "mode", "")) {
          case "first" -> CameraType.FIRST_PERSON;
          case "back" -> CameraType.THIRD_PERSON_BACK;
          case "front" -> CameraType.THIRD_PERSON_FRONT;
          default -> throw ApiException.bad("mode must be first, back or front");
        });
      }
      if (body.has("fixed")) {
        if (fixed == null) {
          Scene.fixedCamera = null;
        } else {
          double[] pos = Json.vector(fixed, "pos");
          if (pos == null) {
            throw ApiException.bad("fixed needs pos: [x, y, z] and either yaw and pitch or at: [x, y, z]");
          }
          float yaw = (float) Json.number(fixed, "yaw", 0);
          float pitch = (float) Json.number(fixed, "pitch", 0);
          double[] at = Json.vector(fixed, "at");
          if (at != null) {
            double dx = at[0] - pos[0];
            double dy = at[1] - pos[1];
            double dz = at[2] - pos[2];
            yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
            pitch = (float) -Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)));
          }
          Scene.fixedCamera = new Scene.Pose(new Vec3(pos[0], pos[1], pos[2]), yaw, pitch);
          // a detached camera in first person would draw the hand at the fixed pose and hide the player
          if (!Json.has(body, "mode") && minecraft.options.getCameraType().isFirstPerson()) {
            minecraft.options.setCameraType(CameraType.THIRD_PERSON_BACK);
          }
        }
      }
      if (Json.has(body, "fov")) {
        int fov = Json.integer(body, "fov", 70);
        if (fov < 30 || fov > 110) throw ApiException.bad("fov must be 30-110");
        minecraft.options.fov().set(fov);
      }
      if (Json.has(body, "hideHud") && Json.bool(body, "hideHud", false) != minecraft.gui.hud.isHidden()) {
        minecraft.gui.hud.toggle();
      }
      if (Json.has(body, "hideHand")) Scene.hideHand = Json.bool(body, "hideHand", false);
      if (Json.has(body, "hidePlayer")) Scene.hidePlayer = Json.bool(body, "hidePlayer", false);
    });
    ClientThread.awaitFrames(2);
    return ClientThread.call(() -> {
      JsonObject json = new JsonObject();
      json.addProperty("mode", switch (minecraft.options.getCameraType()) {
        case FIRST_PERSON -> "first";
        case THIRD_PERSON_BACK -> "back";
        case THIRD_PERSON_FRONT -> "front";
      });
      Scene.Pose pose = Scene.fixedCamera;
      if (pose == null) {
        json.add("fixed", null);
      } else {
        JsonObject poseJson = new JsonObject();
        poseJson.add("pos", Json.array(pose.pos().x, pose.pos().y, pose.pos().z));
        poseJson.addProperty("yaw", pose.yaw());
        poseJson.addProperty("pitch", pose.pitch());
        json.add("fixed", poseJson);
      }
      json.addProperty("fov", minecraft.options.fov().get());
      json.addProperty("hideHud", minecraft.gui.hud.isHidden());
      json.addProperty("hideHand", Scene.hideHand);
      json.addProperty("hidePlayer", Scene.hidePlayer);
      Vec3 pos = minecraft.gameRenderer.mainCamera().position();
      json.add("pos", Json.array(pos.x, pos.y, pos.z));
      return json;
    });
  }

  static JsonElement use(JsonObject body) {
    return interact(body, true);
  }

  static JsonElement attack(JsonObject body) {
    return interact(body, false);
  }

  private static JsonElement interact(JsonObject body, boolean use) {
    Minecraft minecraft = Minecraft.getInstance();
    String wanted = Json.string(body, "target", null);
    if (wanted != null && !java.util.List.of("item", "block", "entity").contains(wanted)) {
      throw ApiException.bad("target must be item, block or entity");
    }
    JsonElement before = ClientThread.call(() -> {
      player(minecraft);
      if (minecraft.gui.screen() != null) {
        throw ApiException.conflict("a screen is open (" + minecraft.gui.screen().getClass().getSimpleName()
          + "), close it first");
      }
      HitResult hit = minecraft.hitResult;
      String actual = hit == null || hit.getType() == HitResult.Type.MISS ? "item"
        : hit.getType().name().toLowerCase(Locale.ROOT);
      if (wanted != null && !wanted.equals(actual)) {
        throw ApiException.conflict("the crosshair is on " + (actual.equals("item") ? "nothing" : "a " + actual)
          + ", not on " + (wanted.equals("item") ? "nothing" : "a " + wanted) + "; aim with /look first");
      }
      JsonElement target = target(minecraft);
      if (use) {
        Reflect.set(Minecraft.class, minecraft, "rightClickDelay", 0);
        Reflect.invoke(Minecraft.class, minecraft, "startUseItem", new Class<?>[0]);
      } else {
        // the game ignores attacks for a while after the mouse was (re)grabbed
        Reflect.set(Minecraft.class, minecraft, "missTime", 0);
        Reflect.invoke(Minecraft.class, minecraft, "startAttack", new Class<?>[0]);
      }
      return target;
    });
    Readiness.awaitTicks(3);
    ClientThread.awaitFrames(2);
    return ClientThread.call(() -> {
      JsonObject json = new JsonObject();
      json.add("target", before);
      json.add("screen", GameApi.screenJson(minecraft.gui.screen()));
      return json;
    });
  }

  static JsonElement hotbar(JsonObject body) {
    Minecraft minecraft = Minecraft.getInstance();
    if (!Json.has(body, "slot")) throw ApiException.bad("\"slot\" is required (0-8)");
    int slot = Json.integer(body, "slot", -1);
    if (slot < 0 || slot > 8) throw ApiException.bad("slot must be 0-8");
    ClientThread.run(() -> player(minecraft).getInventory().setSelectedSlot(slot));
    Readiness.awaitTicks(2);
    try {
      ClientThread.awaitUntil(() -> Readiness.handAtRest(minecraft), 3000, "the held item to settle");
    } catch (ApiException stillMoving) {
      // an item in use never comes to rest; the selection itself is done
    }
    ClientThread.awaitFrames(1);
    return ClientThread.call(() -> {
      JsonObject json = new JsonObject();
      json.addProperty("slot", minecraft.player.getInventory().getSelectedSlot());
      json.add("item", ScreenApi.item(minecraft, minecraft.player.getInventory().getSelectedItem()));
      return json;
    });
  }
}
