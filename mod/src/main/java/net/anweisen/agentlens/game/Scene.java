package net.anweisen.agentlens.game;

import net.minecraft.client.gui.screens.Screen;
import net.minecraft.world.phys.Vec3;

/** Scene overrides the mixins read every frame. Written on the client thread. */
public final class Scene {

  /** Virtual mouse target; the pixel position is recomputed every frame so it survives re-layouts. */
  public record Hover(Screen screen, Integer slot, Double x, Double y, String widget) {
  }

  public record Pose(Vec3 pos, float yaw, float pitch) {
  }

  public static volatile int forcedGuiScale;
  public static volatile Hover hover;
  public static volatile Pose fixedCamera;
  public static volatile boolean hideHand;
  public static volatile boolean hidePlayer;
  public static volatile boolean holdHud;
  public static volatile boolean steadyPlayer = true;
  public static volatile boolean itemName;
  /** Set around a shot whose region is not the chat: chat lines would overlap other HUD parts. */
  public static volatile boolean hideChat;
  /**
   * Set around a shot of the chat: the HUD sections to draw (everything else could lie on top of the chat lines),
   * and the lines are shown as they were when the newest one arrived instead of fading out after 10 s.
   */
  public static volatile java.util.Set<String> chatShot;
  public static volatile boolean toasts;
  public static volatile boolean textCursor;

  private Scene() {
  }
}
