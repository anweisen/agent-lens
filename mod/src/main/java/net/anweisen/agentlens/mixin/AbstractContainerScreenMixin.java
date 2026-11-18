package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.capture.Regions;
import net.anweisen.agentlens.game.Scene;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

@Mixin(AbstractContainerScreen.class)
public abstract class AbstractContainerScreenMixin {

  // the container title as its own region, and a switch to leave it out of one frame: a resource pack's shader can
  // draw it somewhere else than its layout says, so Capture measures it from the pixels it changes
  @Redirect(method = "extractLabels", at = @At(value = "INVOKE", ordinal = 0, target =
    "Lnet/minecraft/client/gui/GuiGraphicsExtractor;text(Lnet/minecraft/client/gui/Font;Lnet/minecraft/network/chat/Component;IIIZ)V"))
  private void lens$title(GuiGraphicsExtractor graphics, Font font, Component title, int x, int y, int color,
                          boolean shadow) {
    if (Scene.hideTitle) return;
    Regions.begin(Regions.TITLE);
    try {
      graphics.text(font, title, x, y, color, shadow);
    } finally {
      Regions.end(Regions.TITLE);
    }
  }
}
