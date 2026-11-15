package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.game.Scene;
import net.minecraft.client.gui.components.TextCursorUtils;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(TextCursorUtils.class)
public abstract class TextCursorUtilsMixin {

  // the text cursor blinks with wall-clock time: steady on or off instead
  @Inject(method = "isCursorVisible", at = @At("HEAD"), cancellable = true)
  private static void lens$steady(CallbackInfoReturnable<Boolean> cir) {
    cir.setReturnValue(Scene.textCursor);
  }
}
