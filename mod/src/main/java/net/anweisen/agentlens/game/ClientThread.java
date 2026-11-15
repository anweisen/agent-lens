package net.anweisen.agentlens.game;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import net.anweisen.agentlens.http.ApiException;
import net.minecraft.client.Minecraft;

/**
 * How API threads reach the game: tasks run on the client thread, and waits are conditions evaluated on the client
 * thread at the end of every rendered frame.
 */
public final class ClientThread {

  private static volatile long frame;
  private static final List<Waiter> WAITERS = new ArrayList<>();

  private record Waiter(BooleanSupplier condition, CompletableFuture<Void> done) {
  }

  private ClientThread() {
  }

  /** Number of completed frames. */
  public static long frame() {
    return frame;
  }

  static void countFrame() {
    frame++;
  }

  /** Client thread, after every completed frame: completes the waits whose condition now holds. */
static void runWaiters() {
    List<Waiter> due = new ArrayList<>();
    synchronized (WAITERS) {
      if (WAITERS.isEmpty()) return;
      due.addAll(WAITERS);
    }
    for (Waiter waiter : due) {
      boolean finished;
      try {
        finished = waiter.done.isDone() || waiter.condition.getAsBoolean();
        if (finished) waiter.done.complete(null);
      } catch (Throwable error) {
        finished = true;
        waiter.done.completeExceptionally(error);
      }
      if (finished) {
        synchronized (WAITERS) {
          WAITERS.remove(waiter);
        }
      }
    }
  }

  /** Runs on the client thread and returns the result; API threads block meanwhile. */
  public static <T> T call(Callable<T> task) {
    return call(30_000, task);
  }

  public static <T> T call(long timeoutMs, Callable<T> task) {
    Minecraft minecraft = Minecraft.getInstance();
    if (minecraft.isSameThread()) {
      try {
        return task.call();
      } catch (RuntimeException error) {
        throw error;
      } catch (Exception error) {
        throw new IllegalStateException(error);
      }
    }
    CompletableFuture<T> future = new CompletableFuture<>();
    minecraft.execute(() -> {
      try {
        future.complete(task.call());
      } catch (Throwable error) {
        future.completeExceptionally(error);
      }
    });
    return await(future, timeoutMs, "the client thread");
  }

  public static void run(Runnable task) {
    call(() -> {
      task.run();
      return null;
    });
  }

  public static <T> T await(CompletableFuture<T> future, long timeoutMs, String what) {
    try {
      return future.get(timeoutMs, TimeUnit.MILLISECONDS);
    } catch (ExecutionException error) {
      Throwable cause = error.getCause();
      if (cause instanceof RuntimeException runtime) throw runtime;
      throw new IllegalStateException(cause);
    } catch (TimeoutException error) {
      future.cancel(false);
      throw ApiException.timeout("timed out after " + timeoutMs + " ms waiting for " + what);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new ApiException(500, "interrupted");
    }
  }

  /** Completes at the end of the first frame for which the condition (evaluated on the client thread) holds. */
  public static CompletableFuture<Void> whenFrame(BooleanSupplier condition) {
    CompletableFuture<Void> done = new CompletableFuture<>();
    synchronized (WAITERS) {
      WAITERS.add(new Waiter(condition, done));
    }
    return done;
  }

  public static void awaitFrames(int count) {
    if (count <= 0) return;
    // a frame already in flight when the request arrived does not count, hence +1
    long target = frame + count + 1;
    await(whenFrame(() -> frame >= target), 30_000, count + " frames");
  }

  public static void awaitUntil(BooleanSupplier condition, long timeoutMs, String what) {
    await(whenFrame(condition), timeoutMs, what);
  }
}
