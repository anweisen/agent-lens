package net.anweisen.agentlens.game;

import net.minecraft.client.CloudStatus;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Options;

/** Options that would make two captures of the same scene differ. In memory only, options.txt stays untouched. */
public final class Determinism {

  private Determinism() {
  }

  public static void applyOptions(Minecraft minecraft) {
    Options options = minecraft.options;
    options.cloudStatus().set(CloudStatus.OFF);
    options.bobView().set(false);
    options.fovEffectScale().set(0.0);
    options.screenEffectScale().set(0.0);
    options.damageTiltStrength().set(0.0);
    // the enchantment glint scrolls with wall-clock time
    options.glintSpeed().set(0.0);
    options.showAutosaveIndicator().set(false);
    options.showSubtitles().set(false);
    options.chunkSectionFadeInTime().set(0.0);
    options.pauseOnLostFocus = false;
  }
}
