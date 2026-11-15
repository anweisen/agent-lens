package net.anweisen.agentlens.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import com.mojang.serialization.JsonOps;
import java.util.List;
import java.util.Locale;
import net.anweisen.agentlens.capture.Capture;
import net.anweisen.agentlens.capture.Regions;
import net.anweisen.agentlens.capture.Texts;
import net.anweisen.agentlens.core.Lens;
import net.anweisen.agentlens.game.ClientThread;
import net.anweisen.agentlens.game.Scene;
import net.anweisen.agentlens.game.Screens;
import net.anweisen.agentlens.game.Ticks;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.http.Json;
import net.anweisen.agentlens.util.Rect;
import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.MouseHandler;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.components.events.ContainerEventHandler;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonInfo;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.ComponentSerialization;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.ItemLore;
import org.lwjgl.sdl.SDLKeyboard;

final class ScreenApi {

  private ScreenApi() {
  }

  static JsonElement screen(JsonObject body) {
    return ClientThread.call(() -> {
      Minecraft minecraft = Minecraft.getInstance();
      Screen screen = minecraft.gui.screen();
      JsonObject json = new JsonObject();
      var window = minecraft.getWindow();
      json.addProperty("guiScale", window.getGuiScale());
      json.addProperty("guiWidth", window.getGuiScaledWidth());
      json.addProperty("guiHeight", window.getGuiScaledHeight());
      if (screen == null) {
        json.add("class", null);
        return json;
      }
      json.addProperty("class", screen.getClass().getName());
      json.addProperty("title", screen.getTitle().getString());
      json.add("titleJson", componentJson(minecraft, screen.getTitle()));
      Rect rect = Capture.allRegions().get("screen");
      json.add("rect", rect == null ? null : rect.json());
      JsonArray widgets = new JsonArray();
      for (Screens.Widget widget : Screens.widgets(screen)) {
        JsonObject entry = new JsonObject();
        entry.addProperty("label", widget.label());
        entry.addProperty("type", widget.widget().getClass().getSimpleName());
        entry.add("rect", Screens.toPixels(widget.rect()).json());
        entry.addProperty("active", widget.widget().active);
        widgets.add(entry);
      }
      json.add("widgets", widgets);
      if (screen instanceof AbstractContainerScreen<?> container) {
        JsonArray slots = new JsonArray();
        List<Slot> all = container.getMenu().slots;
        for (int index = 0; index < all.size(); index++) {
          Slot slot = all.get(index);
          JsonObject entry = new JsonObject();
          entry.addProperty("index", index);
          entry.add("rect", Screens.toPixels(Screens.slotRect(container, slot)).json());
          entry.add("item", item(minecraft, slot.getItem()));
          if (Screens.isPlayerSlot(slot)) entry.addProperty("player", true);
          slots.add(entry);
        }
        json.add("slots", slots);
        json.add("carried", item(minecraft, container.getMenu().getCarried()));
      }
      return json;
    });
  }

  static JsonElement item(Minecraft minecraft, ItemStack stack) {
    if (stack == null || stack.isEmpty()) return null;
    JsonObject json = new JsonObject();
    json.addProperty("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
    json.addProperty("count", stack.getCount());
    json.addProperty("name", stack.getHoverName().getString());
    JsonArray lore = new JsonArray();
    ItemLore itemLore = stack.get(DataComponents.LORE);
    if (itemLore != null) for (Component line : itemLore.lines()) lore.add(line.getString());
    json.add("lore", lore);
    JsonArray tooltip = new JsonArray();
    try {
      for (Component line : Screen.getTooltipFromItem(minecraft, stack)) tooltip.add(line.getString());
    } catch (RuntimeException error) {
      Lens.LOG.debug("tooltip lines failed", error);
    }
    json.add("tooltip", tooltip);
    return json;
  }

  static JsonElement regions(JsonObject body) {
    ClientThread.awaitFrames(1);
    return ClientThread.call(() -> Capture.regionsJson(Capture.allRegions()));
  }

  /** Client thread. Validates the target against the open screen. */
  static Scene.Hover parseHover(JsonObject spec) {
    if (Json.bool(spec, "none", false)) return null;
    Screen screen = Screens.current();
    if (Json.has(spec, "slot")) {
      AbstractContainerScreen<?> container = Screens.requireContainer();
      int slot = Json.integer(spec, "slot", -1);
      Screens.slot(container, slot);
      return new Scene.Hover(screen, slot, null, null, null);
    }
    if (Json.has(spec, "item")) {
      int slot = Screens.slotByItem(Screens.requireContainer(), Json.require(spec, "item"));
      return new Scene.Hover(screen, slot, null, null, null);
    }
    if (Json.has(spec, "widget")) {
      String label = Json.require(spec, "widget");
      Screens.widget(Screens.require(), label);
      return new Scene.Hover(screen, null, null, null, label);
    }
    if (Json.has(spec, "x") && Json.has(spec, "y")) {
      return new Scene.Hover(screen, null, Json.number(spec, "x", 0), Json.number(spec, "y", 0), null);
    }
    throw ApiException.bad("expected {slot}, {item} (name pattern), {text} (pattern of text on screen), {x, y} "
      + "(GUI coordinates), {widget} or {none: true}");
  }

  static JsonElement hover(JsonObject body) {
    JsonObject target = locateText(body);
    ClientThread.run(() -> Scene.hover = parseHover(target));
    ClientThread.awaitFrames(2);
    JsonObject json = ClientThread.call(() -> {
      JsonObject result = new JsonObject();
      double[] gui = Screens.hoverGui(Scene.hover);
      result.add("gui", gui == null ? null : Json.array(gui[0], gui[1]));
      if (target != body) result.add("matched", target.get("matched"));
      JsonElement hovered = hovered();
      if (hovered != null) result.add("hovered", hovered);
      Rect tooltip = Regions.current().get("tooltip");
      result.add("tooltip", tooltip == null ? null : tooltip.json());
      return result;
    });
    if (!json.has("hovered") && !json.get("tooltip").isJsonNull()) json.add("tooltipText", tooltipText());
    return json;
  }

  /**
   * API thread. A target given as {text: pattern} becomes the {x, y} where that text is drawn in the next frame
   * (plus "matched" for the answer); any other target is returned as it is.
   */
  static JsonObject locateText(JsonObject spec) {
    if (spec == null || !Json.has(spec, "text")) return spec;
    Texts.Located at = Texts.locate(Json.require(spec, "text"));
    JsonObject target = spec.deepCopy();
    target.remove("text");
    target.addProperty("x", at.x());
    target.addProperty("y", at.y());
    JsonObject matched = new JsonObject();
    matched.addProperty("text", at.text());
    matched.addProperty("matches", at.matches());
    target.add("matched", matched);
    return target;
  }

  /** API thread. The lines drawn inside the tooltip of the next frame, top to bottom: any tooltip, not only items. */
  static JsonArray tooltipText() {
    List<Texts.Run> runs = Texts.snapshot();
    return ClientThread.call(() -> {
      JsonArray lines = new JsonArray();
      Rect tooltip = Regions.current().get("tooltip");
      if (tooltip == null) return lines;
      int scale = Screens.scale();
      // a line of the tooltip starts and ends inside it; text behind it (a chat line) does not
      runs.stream().filter(run -> inside(tooltip, run.gui(0, 0), scale)
          && inside(tooltip, run.gui(run.text().length(), run.text().length()), scale))
        .map(run -> new Object[] {run.gui(0, run.text().length()), run.text()})
        .sorted(java.util.Comparator.comparingDouble(entry -> ((double[]) entry[0])[1]))
        .forEach(entry -> lines.add((String) entry[1]));
      return lines;
    });
  }

  private static boolean inside(Rect rect, double[] gui, int scale) {
    return gui[0] * scale >= rect.x() && gui[0] * scale <= rect.right()
      && gui[1] * scale >= rect.y() && gui[1] * scale <= rect.bottom();
  }

  static JsonElement texts(JsonObject body) {
    JsonArray texts = new JsonArray();
    for (Texts.Run run : Texts.snapshot()) {
      double[] gui = run.gui(0, run.text().length());
      JsonObject entry = new JsonObject();
      entry.addProperty("text", run.text());
      entry.addProperty("x", Math.round(gui[0]));
      entry.addProperty("y", Math.round(gui[1]));
      texts.add(entry);
    }
    JsonObject json = new JsonObject();
    json.add("texts", texts);
    return json;
  }

  static JsonElement click(JsonObject body) {
    int button = switch (Json.string(body, "button", "left").toLowerCase(Locale.ROOT)) {
      case "left", "0" -> 1;
      case "middle" -> 2;
      case "right", "1" -> 3;
      default -> throw ApiException.bad("button must be left, right or middle");
    };
    int modifiers = (Json.bool(body, "shift", false) ? 1 : 0) | (Json.bool(body, "ctrl", false) ? 0x40 : 0);
    boolean doubleClick = Json.bool(body, "double", false);
    JsonObject spec = locateText(body);
    ClientThread.run(() -> {
      Screens.require();
      Scene.Hover target = parseHover(spec);
      if (target == null) throw ApiException.bad("expected {slot}, {item}, {x, y} (GUI coordinates) or {widget}");
      clickAt(target, button, modifiers, doubleClick ? 2 : 1);
    });
    ClientThread.awaitFrames(2);
    return ClientThread.call(() -> {
      JsonObject json = new JsonObject();
      json.add("screen", GameApi.screenJson(Screens.current()));
      return json;
    });
  }

  /** Client thread. The slot under the virtual mouse with its item name and tooltip lines as text, or null. */
  static JsonElement hovered() {
    Scene.Hover hover = Scene.hover;
    AbstractContainerScreen<?> container = Screens.container();
    if (hover == null || hover.slot() == null || container == null || hover.screen() != container) return null;
    List<Slot> slots = container.getMenu().slots;
    if (hover.slot() >= slots.size()) return null;
    Slot slot = slots.get(hover.slot());
    JsonObject json = new JsonObject();
    json.addProperty("slot", hover.slot());
    if (slot.getItem().isEmpty()) return json;
    json.addProperty("name", Screens.itemName(slot));
    JsonObject item = item(Minecraft.getInstance(), slot.getItem()).getAsJsonObject();
    json.add("tooltip", item.get("tooltip"));
    return json;
  }

  /** Client thread. Moves the virtual mouse onto the target and presses a button there. */
  private static void clickAt(Scene.Hover target, int button, int modifiers, int presses) {
    Minecraft minecraft = Minecraft.getInstance();
    Scene.hover = target;
    double[] pixel = Screens.hoverPixel(minecraft);
    MouseHandler mouse = minecraft.mouseHandler;
    Reflect.set(MouseHandler.class, mouse, "xpos", pixel[0]);
    Reflect.set(MouseHandler.class, mouse, "ypos", pixel[1]);
    long handle = minecraft.getWindow().handle();
    MouseButtonInfo info = new MouseButtonInfo(button, modifiers);
    for (int press = 0; press < presses; press++) {
      // two API clicks in quick succession must not turn into a double click by accident
      if (press == 0) Reflect.set(MouseHandler.class, mouse, "lastClick", null);
      mouse.onButton(handle, info, 1);
      mouse.onButton(handle, info, 0);
    }
  }

  /** The innermost focused element of the screen, or null. */
  private static GuiEventListener focusedLeaf(Screen screen) {
    GuiEventListener focused = screen.getFocused();
    for (int depth = 0; depth < 8 && focused instanceof ContainerEventHandler container; depth++) {
      if (container.getFocused() == null) break;
      focused = container.getFocused();
    }
    return focused;
  }

  private static boolean isTextInput(Object widget) {
    return widget instanceof EditBox || widget instanceof MultiLineEditBox;
  }

  static JsonElement type(JsonObject body) {
    String text = Json.require(body, "text");
    boolean clear = Json.bool(body, "clear", false);
    String label = Json.string(body, "widget", null);
    Minecraft minecraft = Minecraft.getInstance();
    ClientThread.run(() -> {
      Screen screen = Screens.require();
      // a dialog labels an input with a text widget of the same name, so only text inputs are candidates
      List<Screens.Widget> inputs = Screens.widgets(screen).stream()
        .filter(widget -> isTextInput(widget.widget()) && widget.widget().active).toList();
      Screens.Widget wanted = null;
      if (label != null) {
        String lower = label.toLowerCase(Locale.ROOT);
        for (Screens.Widget input : inputs) if (wanted == null && input.label().equals(label)) wanted = input;
        for (Screens.Widget input : inputs) if (wanted == null && input.label().equalsIgnoreCase(label)) wanted = input;
        for (Screens.Widget input : inputs) {
          if (wanted == null && input.label().toLowerCase(Locale.ROOT).contains(lower)) wanted = input;
        }
        if (wanted == null) {
          throw new ApiException(404, "no text input labelled \"" + label + "\", text inputs: "
            + inputs.stream().map(Screens.Widget::label).toList());
        }
      } else if (!isTextInput(focusedLeaf(screen)) && !inputs.isEmpty()) {
        // nothing focused: the first text input; a screen without one (sign, book) gets the keys itself
        wanted = inputs.get(0);
      }
      if (wanted != null && focusedLeaf(screen) != wanted.widget()) {
        double x = wanted.rect().x() + wanted.rect().w() / 2.0;
        double y = wanted.rect().y() + wanted.rect().h() / 2.0;
        clickAt(new Scene.Hover(screen, null, x, y, null), 1, 0, 1);
      }
    });
    ClientThread.run(() -> {
      Screen screen = Screens.require();
      GuiEventListener target = focusedLeaf(screen);
      if (target instanceof EditBox box && !box.canConsumeInput()) {
        throw ApiException.conflict("the text input is not editable right now");
      }
      if (clear) {
        if (target instanceof EditBox box) box.setValue("");
        else if (target instanceof MultiLineEditBox box) box.setValue("");
        else {
          // select all, delete: what a sign or book screen understands
          press(minecraft, InputConstants.getKey("key.keyboard.a"), 0x40, true);
          press(minecraft, InputConstants.getKey("key.keyboard.a"), 0x40, false);
          press(minecraft, InputConstants.getKey("key.keyboard.backspace"), 0, true);
          press(minecraft, InputConstants.getKey("key.keyboard.backspace"), 0, false);
        }
      }
      text.codePoints().forEach(codepoint -> {
        if (codepoint == '\n') {
          press(minecraft, InputConstants.getKey("key.keyboard.enter"), 0, true);
          press(minecraft, InputConstants.getKey("key.keyboard.enter"), 0, false);
        } else if (Screens.current() != null) {
          Screens.current().charTyped(new CharacterEvent(codepoint));
        }
      });
    });
    ClientThread.awaitFrames(2);
    return ClientThread.call(() -> {
      JsonObject json = new JsonObject();
      Screen screen = Screens.current();
      GuiEventListener target = screen == null ? null : focusedLeaf(screen);
      json.addProperty("typed", text);
      json.addProperty("widget", target instanceof AbstractWidget widget ? widget.getMessage().getString() : null);
      json.addProperty("value", target instanceof EditBox box ? box.getValue()
        : target instanceof MultiLineEditBox box ? box.getValue() : null);
      json.add("screen", GameApi.screenJson(screen));
      return json;
    });
  }

  /** A text component as the JSON the game would send, for text that plain strings lose (fonts, colours). */
  static JsonElement componentJson(Minecraft minecraft, Component component) {
    try {
      var ops = minecraft.level == null ? JsonOps.INSTANCE
        : minecraft.level.registryAccess().createSerializationContext(JsonOps.INSTANCE);
      return ComponentSerialization.CODEC.encodeStart(ops, component).result().orElse(null);
    } catch (RuntimeException error) {
      return null;
    }
  }

  private static InputConstants.Key resolveKey(String name) {
    String lower = name.toLowerCase(Locale.ROOT);
    KeyMapping mapping = KeyMapping.get(name);
    if (mapping == null) mapping = KeyMapping.get(lower);
    if (mapping != null) return InputConstants.getKey(mapping.saveString());
    String alias = switch (lower) {
      case "esc" -> "escape";
      case "return" -> "enter";
      case "ctrl", "control" -> "left.control";
      case "shift" -> "left.shift";
      case "alt" -> "left.alt";
      case "pageup" -> "page.up";
      case "pagedown" -> "page.down";
      default -> lower;
    };
    for (String candidate : List.of(lower, "key.keyboard." + alias, "key.mouse." + alias)) {
      try {
        InputConstants.Key key = InputConstants.getKey(candidate);
        if (key != null && key != InputConstants.UNKNOWN) return key;
      } catch (RuntimeException unknown) {
        // try the next spelling
      }
    }
    throw ApiException.bad("unknown key \"" + name + "\": use a key binding name (key.inventory), a key name "
      + "(key.keyboard.e) or its short form (e, escape, enter, space, tab, f3, left.shift)");
  }

  static JsonElement key(JsonObject body) {
    String name = Json.require(body, "key");
    String action = Json.string(body, "action", "tap");
    if (!List.of("tap", "down", "up").contains(action)) throw ApiException.bad("action must be tap, down or up");
    int modifiers = (Json.bool(body, "shift", false) ? 1 : 0) | (Json.bool(body, "ctrl", false) ? 0x40 : 0);
    Minecraft minecraft = Minecraft.getInstance();
    InputConstants.Key key = ClientThread.call(() -> resolveKey(name));
    // escape in the world opens the pause menu; the game's own handler does not react to the injected key event
    boolean pause = key.getName().equals("key.keyboard.escape") && !action.equals("up")
      && ClientThread.call(() -> Screens.current() == null && minecraft.level != null);
    Runnable down = pause ? () -> minecraft.pauseGame(false) : () -> press(minecraft, key, modifiers, true);
    Runnable up = () -> press(minecraft, key, modifiers, false);
    if (!action.equals("up")) ClientThread.run(down);
    if (action.equals("tap")) {
      // in the world a key press only takes effect in the next client tick
      long tick = ClientThread.call(Ticks::client);
      ClientThread.awaitUntil(() -> Ticks.client() > tick || Screens.current() != null, 2000, "a client tick");
    }
    if (!action.equals("down")) ClientThread.run(up);
    ClientThread.awaitFrames(2);
    return ClientThread.call(() -> {
      JsonObject json = new JsonObject();
      json.addProperty("key", key.getName());
      json.add("screen", GameApi.screenJson(Screens.current()));
      return json;
    });
  }

  private static void press(Minecraft minecraft, InputConstants.Key key, int modifiers, boolean down) {
    long handle = minecraft.getWindow().handle();
    if (key.getType() == InputConstants.Type.MOUSE) {
      minecraft.mouseHandler.onButton(handle, new MouseButtonInfo(key.getValue(), modifiers), down ? 1 : 0);
      return;
    }
    int keycode = SDLKeyboard.SDL_GetKeyFromScancode(key.getValue(), (short) 0, false);
    minecraft.keyboardHandler.keyPress(handle, down ? 1 : 0, new KeyEvent(key.getValue(), keycode, modifiers));
  }
}
