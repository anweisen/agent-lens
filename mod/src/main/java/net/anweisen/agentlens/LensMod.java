package net.anweisen.agentlens;

import net.anweisen.agentlens.core.Lens;
import net.fabricmc.api.ClientModInitializer;

public final class LensMod implements ClientModInitializer {

  @Override
  public void onInitializeClient() {
    // Java2D (compose, sheets, gif) must never try to open a display
    System.setProperty("java.awt.headless", "true");
    Lens.init();
  }
}
