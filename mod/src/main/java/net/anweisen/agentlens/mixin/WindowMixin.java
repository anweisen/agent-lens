package net.anweisen.agentlens.mixin;

import com.mojang.blaze3d.platform.Window;
import net.anweisen.agentlens.game.Scene;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(Window.class)
public abstract class WindowMixin {

  // vanilla caps the scale so the GUI keeps 320x240; evidence shots want the exact scale that was asked for
  @Inject(method = "calculateScale", at = @At("HEAD"), cancellable = true)
  private void lens$scale(int maxScale, boolean enforceUnicode, CallbackInfoReturnable<Integer> cir) {
    int forced = Scene.forcedGuiScale;
    if (forced > 0) cir.setReturnValue(forced);
  }
}
