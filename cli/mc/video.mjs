// mc record stop: turns the frames and the WAV of a recording into one MP4. Needs ffmpeg (config "ffmpeg", else
// ffmpeg on PATH); without it the frames directory and the WAV stay as they are.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function findFfmpeg(config) {
  const candidates = config.ffmpeg ? [config.ffmpeg]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'ffmpeg'));
  return candidates.find(file => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

// result: the answer of POST /record {action: "stop"}. Adds `video` (or `videoSkipped` with the reason).
export function muxRecording(config, result) {
  const frames = result.frames;
  if (!frames?.count) return result;
  const ffmpeg = findFfmpeg(config);
  if (!ffmpeg) {
    return { ...result, videoSkipped: 'ffmpeg not found (config "ffmpeg" or PATH): frames and WAV are kept' };
  }
  // every frame is shown from its own time (the first from 0) until the next one, so picture and sound stay
  // aligned even when a frame was grabbed late
  const starts = frames.ms.map((ms, index) => (index === 0 ? 0 : ms));
  const lines = ['ffconcat version 1.0'];
  starts.forEach((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : Math.max(result.durationMs, start + 50);
    lines.push(`file frame-${String(index).padStart(4, '0')}.png`, `duration ${((end - start) / 1000).toFixed(3)}`);
  });
  // the concat demuxer ignores the last duration unless the file is named once more
  lines.push(`file frame-${String(starts.length - 1).padStart(4, '0')}.png`);
  const list = path.join(frames.dir, 'frames.ffconcat');
  fs.writeFileSync(list, `${lines.join('\n')}\n`);
  const video = result.file.replace(/\.wav$/i, '.mp4');
  const run = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', result.file,
    // H.264 needs even sizes; 20 fps is one frame per game tick
    '-vf', 'fps=20,pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', video,
  ], { encoding: 'utf8' });
  if (run.status !== 0) {
    const reason = (run.stderr || run.error?.message || `exit ${run.status}`).trim().split('\n').slice(-3).join(' | ');
    return { ...result, videoSkipped: `ffmpeg failed: ${reason}` };
  }
  fs.rmSync(frames.dir, { recursive: true, force: true });
  const { dir, ms, ...kept } = frames;
  return { ...result, video, frames: kept };
}
