package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.game.Hooks;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Minecraft.class)
public abstract class MinecraftMixin {

  @Inject(method = "renderFrame", at = @At("TAIL"))
  private void lens$frameEnd(boolean advanceGameTime, CallbackInfo ci) {
    Hooks.frameEnd();
  }
}
