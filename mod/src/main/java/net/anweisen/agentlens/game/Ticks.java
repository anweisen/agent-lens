package net.anweisen.agentlens.game;

import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.Minecraft;

public final class Ticks {

  private Ticks() {
  }

  /** Client ticks since start; advances while a world runs and on menus alike. */
  public static long client() {
    return Reflect.<Long>get(Minecraft.class, Minecraft.getInstance(), "clientTickCount");
  }
}
