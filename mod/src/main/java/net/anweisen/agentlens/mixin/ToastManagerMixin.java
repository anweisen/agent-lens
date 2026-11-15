package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.game.Scene;
import net.minecraft.client.gui.components.toasts.ToastManager;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ToastManager.class)
public abstract class ToastManagerMixin {

  // dropped, not queued: a toast held back would slide in as soon as toasts are switched on
  @Inject(method = "addToast", at = @At("HEAD"), cancellable = true)
  private void lens$drop(CallbackInfo ci) {
    if (!Scene.toasts) ci.cancel();
  }

  @Inject(method = "extractRenderState", at = @At("HEAD"), cancellable = true)
  private void lens$hide(CallbackInfo ci) {
    if (!Scene.toasts) ci.cancel();
  }
}
