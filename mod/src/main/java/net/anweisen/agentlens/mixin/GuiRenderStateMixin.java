package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.capture.Regions;
import net.minecraft.client.renderer.state.gui.GuiRenderState;
import net.minecraft.client.renderer.state.gui.ScreenArea;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(GuiRenderState.class)
public abstract class GuiRenderStateMixin {

  // every item, text, picture-in-picture and element submission passes through here with its final bounds
  @Inject(method = "findAppropriateNode", at = @At("HEAD"))
  private void lens$record(ScreenArea area, CallbackInfoReturnable<Boolean> cir) {
    Regions.add(area.bounds());
  }
}
