package net.anweisen.agentlens.mixin;

import com.mojang.blaze3d.platform.FramerateLimitTracker;
import net.anweisen.agentlens.core.Lens;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(FramerateLimitTracker.class)
public abstract class FramerateLimitTrackerMixin {

  @Inject(method = "getFramerateLimit", at = @At("HEAD"), cancellable = true)
  private void lens$limit(CallbackInfoReturnable<Integer> cir) {
    int limit = Lens.fpsLimit();
    if (limit > 0) cir.setReturnValue(limit);
  }
}
