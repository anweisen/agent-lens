package net.anweisen.agentlens.util;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Private game members by their Mojang names (26.x ships unobfuscated). */
public final class Reflect {

  private static final Map<String, Field> FIELDS = new ConcurrentHashMap<>();
  private static final Map<String, Method> METHODS = new ConcurrentHashMap<>();

  private Reflect() {
  }

  private static Field field(Class<?> owner, String name) {
    return FIELDS.computeIfAbsent(owner.getName() + '#' + name, key -> {
      try {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        return field;
      } catch (ReflectiveOperationException error) {
        throw new IllegalStateException("field " + key + " not found (game version changed?)", error);
      }
    });
  }

  @SuppressWarnings("unchecked")
  public static <T> T get(Class<?> owner, Object instance, String name) {
    try {
      return (T) field(owner, name).get(instance);
    } catch (IllegalAccessException error) {
      throw new IllegalStateException(error);
    }
  }

  public static void set(Class<?> owner, Object instance, String name, Object value) {
    try {
      field(owner, name).set(instance, value);
    } catch (IllegalAccessException error) {
      throw new IllegalStateException(error);
    }
  }

  public static Object invoke(Class<?> owner, Object instance, String name, Class<?>[] types, Object... args) {
    Method method = METHODS.computeIfAbsent(owner.getName() + '#' + name, key -> {
      try {
        Method found = owner.getDeclaredMethod(name, types);
        found.setAccessible(true);
        return found;
      } catch (ReflectiveOperationException error) {
        throw new IllegalStateException("method " + key + " not found (game version changed?)", error);
      }
    });
    try {
      return method.invoke(instance, args);
    } catch (java.lang.reflect.InvocationTargetException error) {
      if (error.getCause() instanceof RuntimeException runtime) throw runtime;
      throw new IllegalStateException(error.getCause());
    } catch (IllegalAccessException error) {
      throw new IllegalStateException(error);
    }
  }
}
