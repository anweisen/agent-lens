package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.capture.Regions;
import net.minecraft.client.gui.screens.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Screen.class)
public abstract class ScreenMixin {

  @Inject(method = "extractRenderStateWithTooltipAndSubtitles", at = @At("HEAD"))
  private void lens$begin(CallbackInfo ci) {
    Regions.begin(Regions.SCREEN);
  }

  @Inject(method = "extractRenderStateWithTooltipAndSubtitles", at = @At("RETURN"))
  private void lens$end(CallbackInfo ci) {
    Regions.end(Regions.SCREEN);
  }
}
