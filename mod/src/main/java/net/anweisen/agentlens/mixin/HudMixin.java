package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.capture.Regions;
import net.anweisen.agentlens.game.Hooks;
import net.anweisen.agentlens.game.Scene;
import net.minecraft.client.gui.Hud;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Hud.class)
public abstract class HudMixin {

  @Shadow private int overlayMessageTime;
  @Shadow private int titleTime;
  @Shadow private int titleFadeOutTime;
  @Shadow private int titleStayTime;
  @Shadow private int toolHighlightTimer;
  @Shadow private long healthBlinkTime;

  @Inject(method = {"extractChat", "extractOverlayMessage", "extractTitle", "extractScoreboardSidebar",
    "extractBossOverlay", "extractItemHotbar", "extractHotbarAndDecorations", "extractTabList", "extractEffects",
    "extractCrosshair"}, at = @At("HEAD"))
  private void lens$sectionBegin(CallbackInfo ci) {
    Regions.begin(Hooks.hudSection(ci.getId()));
  }

  @Inject(method = {"extractChat", "extractOverlayMessage", "extractTitle", "extractScoreboardSidebar",
    "extractBossOverlay", "extractItemHotbar", "extractHotbarAndDecorations", "extractTabList", "extractEffects",
    "extractCrosshair"}, at = @At("RETURN"))
  private void lens$sectionEnd(CallbackInfo ci) {
    Regions.end(Hooks.hudSection(ci.getId()));
  }

  // a shot of the chat: nothing else of the HUD may lie on top of the lines (action bar, title, item name, ...)
  @Inject(method = {"extractOverlayMessage", "extractTitle", "extractScoreboardSidebar", "extractBossOverlay",
    "extractTabList", "extractEffects", "extractCrosshair", "extractSelectedItemName"}, at = @At("HEAD"),
    cancellable = true)
  private void lens$chatOnly(CallbackInfo ci) {
    java.util.Set<String> keep = Scene.chatShot;
    if (keep != null && !keep.contains(Hooks.hudSection(ci.getId()))) ci.cancel();
  }

  // the heart blink after a health change depends on the tick phase of the shot
  @Inject(method = "extractPlayerHealth", at = @At("HEAD"))
  private void lens$noBlink(CallbackInfo ci) {
    healthBlinkTime = 0;
  }

  // holdHud keeps the action bar and title at full opacity instead of letting them fade out
  @Inject(method = "tick()V", at = @At("HEAD"))
  private void lens$hold(CallbackInfo ci) {
    // the held item name pops up and fades relative to when the item changed, not to when a shot is taken
    if (!Scene.itemName) toolHighlightTimer = 0;
    if (!Scene.holdHud) return;
    if (overlayMessageTime > 0) overlayMessageTime = 60;
    if (titleTime > 0) titleTime = titleFadeOutTime + titleStayTime;
  }
}
