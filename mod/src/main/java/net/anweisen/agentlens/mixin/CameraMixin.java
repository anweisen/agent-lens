package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.game.Scene;
import net.minecraft.client.Camera;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Camera.class)
public abstract class CameraMixin {

  @Shadow private boolean detached;

  @Shadow
  protected abstract void setRotation(float yRot, float xRot);

  @Shadow
  protected abstract void setPosition(Vec3 position);

  @Inject(method = "alignWithEntity", at = @At("TAIL"))
  private void lens$pose(float partialTicks, CallbackInfo ci) {
    Scene.Pose pose = Scene.fixedCamera;
    if (pose != null) {
      setRotation(pose.yaw(), pose.pitch());
      setPosition(pose.pos());
      detached = true;
    }
    // the level extractor skips the camera entity unless the camera is detached
    if (Scene.hidePlayer) detached = false;
  }
}
