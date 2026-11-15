package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.game.Scene;
import net.minecraft.client.renderer.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
public abstract class GameRendererMixin {

  @Inject(method = "renderItemInHand", at = @At("HEAD"), cancellable = true)
  private void lens$hideHand(CallbackInfo ci) {
    if (Scene.hideHand) ci.cancel();
  }
}
