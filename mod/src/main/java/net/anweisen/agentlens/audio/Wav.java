package net.anweisen.agentlens.audio;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/** 16-bit PCM, interleaved. Reads what OpenAL Soft's wave writer produces, writes a plain 44-byte-header file. */
public record Wav(int rate, int channels, short[] samples) {

  public int frames() {
    return samples.length / channels;
  }

  public double durationMs() {
    return frames() * 1000.0 / rate;
  }

  public static Wav read(Path file) throws IOException {
    byte[] bytes = Files.readAllBytes(file);
    ByteBuffer buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    if (bytes.length < 44 || buffer.getInt(0) != 0x46464952 || buffer.getInt(8) != 0x45564157) {
      throw new IOException("not a WAVE file: " + file);
    }
    int rate = 0;
    int channels = 0;
    int bits = 0;
    int position = 12;
    while (position + 8 <= bytes.length) {
      int id = buffer.getInt(position);
      int size = buffer.getInt(position + 4);
      int body = position + 8;
      if (id == 0x20746d66) {
        channels = buffer.getShort(body + 2);
        rate = buffer.getInt(body + 4);
        bits = buffer.getShort(body + 14);
      } else if (id == 0x61746164) {
        if (bits != 16 || channels < 1) throw new IOException("expected 16-bit PCM, got " + bits + " bit");
        // the size field is only final once the writer closed the file: trust the file length
        int count = (bytes.length - body) / 2 / channels * channels;
        short[] samples = new short[count];
        buffer.position(body);
        buffer.asShortBuffer().get(samples);
        return new Wav(rate, channels, samples);
      }
      position = body + size + (size & 1);
    }
    throw new IOException("no data chunk in " + file);
  }

  /** Frames [from, to), clamped. */
  public Wav slice(int from, int to) {
    from = Math.clamp(from, 0, frames());
    to = Math.clamp(to, from, frames());
    return new Wav(rate, channels, java.util.Arrays.copyOfRange(samples, from * channels, to * channels));
  }

  public void write(Path file) throws IOException {
    ByteBuffer buffer = ByteBuffer.allocate(44 + samples.length * 2).order(ByteOrder.LITTLE_ENDIAN);
    buffer.putInt(0x46464952).putInt(36 + samples.length * 2).putInt(0x45564157);
    buffer.putInt(0x20746d66).putInt(16).putShort((short) 1).putShort((short) channels).putInt(rate)
      .putInt(rate * channels * 2).putShort((short) (channels * 2)).putShort((short) 16);
    buffer.putInt(0x61746164).putInt(samples.length * 2);
    buffer.asShortBuffer().put(samples);
    if (file.getParent() != null) Files.createDirectories(file.getParent());
    Path tmp = file.resolveSibling(file.getFileName() + ".part");
    Files.write(tmp, buffer.array());
    Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
  }
}
