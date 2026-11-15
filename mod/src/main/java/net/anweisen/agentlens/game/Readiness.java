package net.anweisen.agentlens.game;

import java.util.List;
import net.anweisen.agentlens.core.Lens;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.player.FirstPersonHandsAndItems;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.resources.server.DownloadedPackSource;
import net.minecraft.client.resources.server.ServerPackManager;
import net.minecraft.network.DisconnectionDetails;

/** What state the client is in, and waiting until a joined world is fit for a reproducible shot. */
public final class Readiness {

  private static final List<String> LOADING_SCREENS = List.of("LevelLoadingScreen", "GenericMessageScreen",
    "ReceivingLevelScreen", "ConnectScreen", "ProgressScreen", "ServerReconfigScreen");

  private Readiness() {
  }

  /** loading, title, connecting or ingame. Client thread. */
  public static String state(Minecraft minecraft) {
    if (!minecraft.isGameLoadFinished() || minecraft.gui.overlay() != null) return "loading";
    if (minecraft.level != null && minecraft.player != null) return "ingame";
    Screen screen = minecraft.gui.screen();
    if (screen != null) {
      String name = screen.getClass().getSimpleName();
      if (name.equals("ConnectScreen") || name.equals("LevelLoadingScreen") || name.equals("GenericMessageScreen")
        || name.equals("ReceivingLevelScreen") || name.equals("ProgressScreen")
        || name.contains("ServerReconfig")) {
        return "connecting";
      }
    }
    return "title";
  }

  public static boolean isLoadingScreen(Screen screen) {
    return screen != null && LOADING_SCREENS.contains(screen.getClass().getSimpleName());
  }

  /**
   * Client thread. World joined, no loading screen or resource reload, no server pack on its way, chunk meshing
   * queue empty, first-person hand at rest.
   */
  public static boolean readyNow(Minecraft minecraft) {
    return minecraft.level != null && minecraft.player != null && minecraft.gui.overlay() == null
      && !isLoadingScreen(minecraft.gui.screen()) && !serverPackPending(minecraft)
      && minecraft.levelRenderer.hasRenderedAllSections() && handAtRest(minecraft);
  }

  /** After a join or an item change the held item rises and the attack indicator fills, for about 13 ticks. */
  public static boolean handAtRest(Minecraft minecraft) {
    LocalPlayer player = minecraft.player;
    if (player == null) return true;
    FirstPersonHandsAndItems hands = player.firstPersonHandsAndItems();
    float main = Reflect.get(FirstPersonHandsAndItems.class, hands, "mainHandHeight");
    float oldMain = Reflect.get(FirstPersonHandsAndItems.class, hands, "oMainHandHeight");
    float off = Reflect.get(FirstPersonHandsAndItems.class, hands, "offHandHeight");
    float oldOff = Reflect.get(FirstPersonHandsAndItems.class, hands, "oOffHandHeight");
    return main == oldMain && off == oldOff && player.getAttackStrengthScale(0) >= 1 && !player.isSwinging();
  }

  /**
   * A server resource pack that was accepted but is not active yet (still downloading, or waiting for its reload).
   * Reasoned from ServerPackManager, not tested against a server that sends a pack.
   */
  private static boolean serverPackPending(Minecraft minecraft) {
    try {
      Object manager = Reflect.get(DownloadedPackSource.class, minecraft.getDownloadedPackSource(), "manager");
      List<?> packs = Reflect.get(ServerPackManager.class, manager, "packs");
      for (Object pack : packs) {
        Class<?> type = pack.getClass();
        boolean accepted = Reflect.get(type, pack, "promptAccepted");
        Object removal = Reflect.get(type, pack, "removalReason");
        Object activation = Reflect.get(type, pack, "activationStatus");
        if (accepted && removal == null && !"ACTIVE".equals(String.valueOf(activation))) return true;
      }
    } catch (RuntimeException changed) {
      Lens.LOG.debug("server pack state not readable", changed);
    }
    return false;
  }

  private static String disconnectReason(Screen screen) {
    if (!(screen instanceof DisconnectedScreen)) return null;
    DisconnectionDetails details = Reflect.get(DisconnectedScreen.class, screen, "details");
    return screen.getTitle().getString() + ": " + details.reason().getString();
  }

  private static void acceptResourcePack(Screen screen) {
    if (screen instanceof ConfirmScreen && screen.getClass().getName().contains("PackConfirmScreen")) {
      Button yes = Reflect.get(ConfirmScreen.class, screen, "yesButton");
      if (yes != null) {
        Lens.LOG.info("accepting the server resource pack prompt");
        yes.onPress(null);
      }
    }
  }

  public static void awaitReady(long timeoutMs) {
    Minecraft minecraft = Minecraft.getInstance();
    int[] stable = {0};
    try {
      ClientThread.awaitUntil(() -> {
        Screen screen = minecraft.gui.screen();
        String reason = disconnectReason(screen);
        if (reason != null) throw new ApiException(502, "disconnected: " + reason);
        acceptResourcePack(screen);
        stable[0] = readyNow(minecraft) ? stable[0] + 1 : 0;
        return stable[0] >= 5;
      }, timeoutMs, "the world to become ready");
    } catch (ApiException error) {
      if (error.status() != 408) throw error;
      String state = ClientThread.call(() -> {
        Screen screen = minecraft.gui.screen();
        return "state " + state(minecraft) + ", screen "
          + (screen == null ? "none" : screen.getClass().getSimpleName() + " \"" + screen.getTitle().getString() + "\"")
          + ", overlay " + (minecraft.gui.overlay() != null) + ", chunks meshed "
          + minecraft.levelRenderer.hasRenderedAllSections() + ", server pack pending " + serverPackPending(minecraft)
          + ", hand at rest " + handAtRest(minecraft);
      });
      throw ApiException.timeout(error.getMessage() + " (" + state + ")");
    }
  }

  public static void awaitTicks(int ticks) {
    if (ticks <= 0) return;
    long target = ClientThread.call(Ticks::client) + ticks;
    ClientThread.awaitUntil(() -> Ticks.client() >= target, 5000L + ticks * 200L, ticks + " client ticks");
  }
}
