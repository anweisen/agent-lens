package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.game.Scene;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.renderer.entity.EntityRenderer;
import net.minecraft.client.renderer.entity.state.EntityRenderState;
import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(EntityRenderer.class)
public abstract class EntityRendererMixin {

  // the idle arm sway follows the entity age, which differs between two runs of the same scene
  @Inject(method = "extractRenderState", at = @At("TAIL"))
  private void lens$steady(Entity entity, EntityRenderState state, float partialTicks, CallbackInfo ci) {
    if (Scene.steadyPlayer && entity instanceof LocalPlayer) state.ageInTicks = 0;
  }
}
