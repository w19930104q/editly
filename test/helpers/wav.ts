// Minimal PCM WAV reader for test assertions (no external deps).
// Supports PCM integer formats (u8 / s16 / s24 / s32) and f32, any channel count.
import { readFileSync } from "node:fs";

export type WavData = {
  sampleRate: number;
  channels: number;
  /** Interleaved float samples in [-1, 1], shape [frameIndex][channelIndex] */
  frames: Float64Array[];
};

export function readWav(path: string): WavData {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`Not a RIFF/WAVE file: ${path}`);

  let offset = 12;
  let audioFormat = 1;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      audioFormat = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      dataSize = size;
    }

    offset = body + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error(`No data chunk in ${path}`);

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / bytesPerSample / channels);
  const frames: Float64Array[] = [];

  const readSample = (byteOffset: number): number => {
    switch (bitsPerSample) {
      case 8:
        return (buf.readUInt8(byteOffset) - 128) / 128;
      case 16:
        return buf.readInt16LE(byteOffset) / 32768;
      case 24: {
        const int24 =
          buf.readUInt8(byteOffset) |
          (buf.readUInt8(byteOffset + 1) << 8) |
          (buf.readUInt8(byteOffset + 2) << 16);
        // Sign-extend 24 bits
        const signed = int24 & 0x800000 ? int24 - 0x1000000 : int24;
        return signed / 8388608;
      }
      case 32:
        return audioFormat === 3
          ? buf.readFloatLE(byteOffset)
          : buf.readInt32LE(byteOffset) / 2147483648;
      default:
        throw new Error(`Unsupported bitsPerSample ${bitsPerSample}`);
    }
  };

  for (let frame = 0; frame < frameCount; frame++) {
    const row = new Float64Array(channels);
    for (let channel = 0; channel < channels; channel++) {
      row[channel] = readSample(dataOffset + (frame * channels + channel) * bytesPerSample);
    }
    frames.push(row);
  }

  return { sampleRate, channels, frames };
}

/** Mono mix-down of one frame (mean across channels). */
export function monoSample(frames: Float64Array[], index: number): number {
  const row = frames[index];
  let sum = 0;
  for (const v of row) sum += v;
  return sum / row.length;
}

/** RMS energy of the mono mix-down over [startFrame, endFrame). */
export function rms(frames: Float64Array[], startFrame: number, endFrame: number): number {
  const start = Math.max(0, Math.floor(startFrame));
  const end = Math.min(frames.length, Math.ceil(endFrame));
  let acc = 0;
  let n = 0;
  for (let i = start; i < end; i++) {
    const v = monoSample(frames, i);
    acc += v * v;
    n++;
  }
  return Math.sqrt(acc / Math.max(1, n));
}
