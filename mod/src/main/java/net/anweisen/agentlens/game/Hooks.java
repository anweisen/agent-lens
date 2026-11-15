package net.anweisen.agentlens.game;

import java.util.Map;
import net.anweisen.agentlens.capture.Regions;
import net.anweisen.agentlens.core.Lens;
import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.MouseHandler;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.network.chat.Component;

/** Entry points for the mixins. Everything here runs on the client thread and must not throw into the game. */
public final class Hooks {

  private static final Map<String, String> HUD_SECTIONS = Map.of(
    "extractChat", "chat",
    "extractOverlayMessage", "actionbar",
    "extractTitle", "title",
    "extractScoreboardSidebar", "sidebar",
    "extractBossOverlay", "bossbar",
    "extractItemHotbar", "hotbar",
    "extractHotbarAndDecorations", "status",
    "extractTabList", "tablist",
    "extractEffects", "effects",
    "extractCrosshair", "crosshair");

  private Hooks() {
  }

  public static String hudSection(String method) {
    return HUD_SECTIONS.getOrDefault(method, method);
  }

  /** After every completed frame. */
  public static void frameEnd() {
    try {
      ClientThread.countFrame();
      Regions.frameEnd();
      Lens.frameEnd();
      ClientThread.runWaiters();
    } catch (Throwable error) {
      Lens.LOG.error("frame hook failed", error);
    }
  }

  public static void guiBegin() {
    try {
      Regions.guiBegin();
      if (!Lens.ready()) return;
      Minecraft minecraft = Minecraft.getInstance();
      double[] position = Screens.hoverPixel(minecraft);
      MouseHandler mouse = minecraft.mouseHandler;
      Reflect.set(MouseHandler.class, mouse, "xpos", position[0]);
      Reflect.set(MouseHandler.class, mouse, "ypos", position[1]);
    } catch (Throwable error) {
      Lens.LOG.error("gui hook failed", error);
    }
  }

  public static void guiEnd() {
    try {
      Regions.guiEnd();
    } catch (Throwable error) {
      Lens.LOG.error("gui hook failed", error);
    }
  }

  public static boolean hideChat() {
    return Scene.hideChat && !(Minecraft.getInstance().gui.screen() instanceof ChatScreen);
  }

  public static void chatMessage(Component message) {
    try {
      ChatLog.add(message.getString());
    } catch (Throwable error) {
      Lens.LOG.error("chat hook failed", error);
    }
  }
}
