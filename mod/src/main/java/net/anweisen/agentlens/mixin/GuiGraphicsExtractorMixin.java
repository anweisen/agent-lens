package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.capture.Regions;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GuiGraphicsExtractor.class)
public abstract class GuiGraphicsExtractorMixin {

  @Inject(method = "tooltip", at = @At("HEAD"))
  private void lens$tooltipBegin(CallbackInfo ci) {
    Regions.begin("tooltip");
  }

  @Inject(method = "tooltip", at = @At("RETURN"))
  private void lens$tooltipEnd(CallbackInfo ci) {
    Regions.end("tooltip");
  }
}
