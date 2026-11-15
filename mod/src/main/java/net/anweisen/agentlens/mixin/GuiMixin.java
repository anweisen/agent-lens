package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.game.Hooks;
import net.minecraft.client.gui.Gui;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Gui.class)
public abstract class GuiMixin {

  @Inject(method = "extractRenderState", at = @At("HEAD"))
  private void lens$begin(CallbackInfo ci) {
    Hooks.guiBegin();
  }

  @Inject(method = "extractRenderState", at = @At("RETURN"))
  private void lens$end(CallbackInfo ci) {
    Hooks.guiEnd();
  }
}
