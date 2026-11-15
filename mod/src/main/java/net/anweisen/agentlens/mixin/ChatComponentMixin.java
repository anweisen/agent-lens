package net.anweisen.agentlens.mixin;

import net.anweisen.agentlens.game.Hooks;
import net.minecraft.client.gui.components.ChatComponent;
import net.minecraft.client.multiplayer.chat.GuiMessageSource;
import net.minecraft.client.multiplayer.chat.GuiMessageTag;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MessageSignature;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ChatComponent.class)
public abstract class ChatComponentMixin {

  @Inject(method = "addMessage", at = @At("HEAD"))
  private void lens$message(Component contents, MessageSignature signature, GuiMessageSource source, GuiMessageTag tag,
    CallbackInfo ci) {
    Hooks.chatMessage(contents);
  }

  @Inject(method = "extractRenderState(Lnet/minecraft/client/gui/GuiGraphicsExtractor;Lnet/minecraft/client/gui/Font;"
    + "IIILnet/minecraft/client/gui/components/ChatComponent$DisplayMode;Z)V", at = @At("HEAD"), cancellable = true)
  private void lens$hide(CallbackInfo ci) {
    if (Hooks.hideChat()) ci.cancel();
  }

  @org.spongepowered.asm.mixin.Shadow
  @org.spongepowered.asm.mixin.Final
  private java.util.List<net.minecraft.client.multiplayer.chat.GuiMessage.Line> trimmedMessages;

  // Closed chat shows a line for 10 s. For a shot of the chat (or with holdHud) the clock stops at the moment the
  // newest line arrived: the lines a player saw then are drawn, however long ago that was.
  @org.spongepowered.asm.mixin.injection.ModifyVariable(
    method = "extractRenderState(Lnet/minecraft/client/gui/GuiGraphicsExtractor;Lnet/minecraft/client/gui/Font;"
      + "IIILnet/minecraft/client/gui/components/ChatComponent$DisplayMode;Z)V",
    at = @At("HEAD"), argsOnly = true, ordinal = 0)
  private int lens$holdLines(int tickCount) {
    if ((net.anweisen.agentlens.game.Scene.chatShot == null && !net.anweisen.agentlens.game.Scene.holdHud)
      || trimmedMessages.isEmpty()) {
      return tickCount;
    }
    return trimmedMessages.get(0).addedTime();
  }
}
