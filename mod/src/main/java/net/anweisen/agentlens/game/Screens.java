package net.anweisen.agentlens.game;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.anweisen.agentlens.http.ApiException;
import net.anweisen.agentlens.util.Rect;
import net.anweisen.agentlens.util.Reflect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.events.ContainerEventHandler;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.world.inventory.Slot;

/** Geometry of the open screen. GUI coordinates unless a method says pixels. Client thread only. */
public final class Screens {

  private static final double[] OFFSCREEN = {-10000, -10000};

  private Screens() {
  }

  public static Screen current() {
    return Minecraft.getInstance().gui.screen();
  }

  public static Screen require() {
    Screen screen = current();
    if (screen == null) throw ApiException.conflict("no screen is open");
    return screen;
  }

  public static AbstractContainerScreen<?> container() {
    return current() instanceof AbstractContainerScreen<?> container ? container : null;
  }

  public static AbstractContainerScreen<?> requireContainer() {
    Screen screen = require();
    if (screen instanceof AbstractContainerScreen<?> container) return container;
    throw ApiException.conflict("the open screen " + screen.getClass().getSimpleName() + " has no slots");
  }

  public static int scale() {
    return Minecraft.getInstance().getWindow().getGuiScale();
  }

  public static Rect toPixels(Rect gui) {
    var window = Minecraft.getInstance().getWindow();
    return gui.scale(window.getGuiScale()).clamp(window.getWidth(), window.getHeight());
  }

  public static Rect containerRect(AbstractContainerScreen<?> screen) {
    int left = Reflect.get(AbstractContainerScreen.class, screen, "leftPos");
    int top = Reflect.get(AbstractContainerScreen.class, screen, "topPos");
    int width = Reflect.get(AbstractContainerScreen.class, screen, "imageWidth");
    int height = Reflect.get(AbstractContainerScreen.class, screen, "imageHeight");
    return new Rect(left, top, width, height);
  }

  public static Slot slot(AbstractContainerScreen<?> screen, int index) {
    List<Slot> slots = screen.getMenu().slots;
    if (index < 0 || index >= slots.size()) {
      throw ApiException.bad("slot " + index + " does not exist, the screen has slots 0-" + (slots.size() - 1));
    }
    return slots.get(index);
  }

  public static Rect slotRect(AbstractContainerScreen<?> screen, Slot slot) {
    Rect container = containerRect(screen);
    return new Rect(container.x() + slot.x, container.y() + slot.y, 16, 16);
  }

  public record Widget(AbstractWidget widget, String label, Rect rect) {
  }

  public static List<Widget> widgets(Screen screen) {
    List<Widget> result = new ArrayList<>();
    collect(screen.children(), result, 0);
    return result;
  }

  private static void collect(List<? extends GuiEventListener> children, List<Widget> out, int depth) {
    if (depth > 8) return;
    for (GuiEventListener child : children) {
      if (child instanceof AbstractWidget widget) {
        if (!widget.visible) continue;
        out.add(new Widget(widget, widget.getMessage().getString(),
          new Rect(widget.getX(), widget.getY(), widget.getWidth(), widget.getHeight())));
      }
      if (child instanceof ContainerEventHandler container) collect(container.children(), out, depth + 1);
    }
  }

  public static Widget widget(Screen screen, String label) {
    List<Widget> all = widgets(screen);
    for (Widget widget : all) if (widget.label.equals(label)) return widget;
    String wanted = label.toLowerCase(Locale.ROOT);
    for (Widget widget : all) if (widget.label.toLowerCase(Locale.ROOT).equals(wanted)) return widget;
    for (Widget widget : all) if (widget.label.toLowerCase(Locale.ROOT).contains(wanted)) return widget;
    List<String> labels = all.stream().map(Widget::label).filter(text -> !text.isEmpty()).distinct().toList();
    throw new ApiException(404, "no widget labelled \"" + label + "\", widgets: " + labels);
  }

  /** GUI position the virtual mouse should rest on, or null for "nowhere". */
  public static double[] hoverGui(Scene.Hover hover) {
    if (hover == null) return null;
    Screen screen = current();
    if (hover.screen() != null && hover.screen() != screen) return null;
    try {
      if (hover.slot() != null) {
        if (!(screen instanceof AbstractContainerScreen<?> container)) return null;
        Rect rect = slotRect(container, slot(container, hover.slot()));
        return new double[] {rect.x() + 8, rect.y() + 8};
      }
      if (hover.widget() != null) {
        if (screen == null) return null;
        Rect rect = widget(screen, hover.widget()).rect;
        return new double[] {rect.x() + rect.w() / 2.0, rect.y() + rect.h() / 2.0};
      }
      if (hover.x() != null && hover.y() != null) return new double[] {hover.x(), hover.y()};
    } catch (ApiException gone) {
      return null;
    }
    return null;
  }

  /** Mouse position in framebuffer pixels for this frame. */
  public static double[] hoverPixel(Minecraft minecraft) {
    double[] gui = hoverGui(Scene.hover);
    if (gui == null) return OFFSCREEN;
    var window = minecraft.getWindow();
    return new double[] {
      gui[0] * window.getScreenWidth() / window.getGuiScaledWidth(),
      gui[1] * window.getScreenHeight() / window.getGuiScaledHeight()};
  }
}
