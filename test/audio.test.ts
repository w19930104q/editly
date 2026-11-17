import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import createAudioEngine from "../src/audio.js";
import { Transition } from "../src/transition.js";
import type { AudioLayer, AudioTrack, Clip } from "../src/types.js";
import { readWav, rms } from "./helpers/wav.js";

// All mixing happens at this sample rate (see MIX_SAMPLE_RATE in audio.ts).
const SAMPLE_RATE = 48000;

type Fixture = {
  path: string;
  sampleRate: number;
  frequency: number;
  duration: number;
};

// The audio pipeline reads `speedFactor` off audio layers (see LayerWithAudio).
type TestAudioLayer = AudioLayer & { speedFactor: number };

let workDir: string;

async function makeSine(
  name: string,
  frequency: number,
  sampleRate: number,
  duration: number,
): Promise<Fixture> {
  const path = join(workDir, name);
  await execa(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=${sampleRate}:duration=${duration}`,
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      "-y",
      path,
    ],
    { buffer: true },
  );
  return { path, sampleRate, frequency, duration };
}

// editAudio renders FLAC; transcode to PCM WAV so the test reader can inspect samples.
async function toWav(path: string): Promise<string> {
  const wavPath = path.replace(/\.flac$/, `.${Math.random().toString(36).slice(2)}.wav`);
  await execa(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", path, "-c:a", "pcm_s16le", "-y", wavPath],
    { buffer: true },
  );
  return wavPath;
}

function audioLayer(fixture: Fixture, mixVolume?: number): TestAudioLayer {
  return {
    type: "audio",
    path: fixture.path,
    cutFrom: 0,
    cutTo: fixture.duration,
    speedFactor: 1,
    ...(mixVolume != null ? { mixVolume } : {}),
  };
}

function runEdit(
  engine: ReturnType<typeof createAudioEngine>,
  clips: Clip[],
  arbitraryAudio: AudioTrack[] = [],
) {
  return engine.editAudio({
    keepSourceAudio: true,
    clips,
    arbitraryAudio,
    clipsAudioVolume: 1,
  });
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "editly-audio-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("multi-track audio mixing", () => {
  test("cross-fade follows the linear equal-power rule with a flat energy envelope", async () => {
    const clip1 = await makeSine("clip1.wav", 440, SAMPLE_RATE, 2);
    const clip2 = await makeSine("clip2.wav", 660, SAMPLE_RATE, 2);
    const fadeDuration = 1;

    const engine = createAudioEngine({ verbose: false, tmpDir: workDir });
    const clips: Clip[] = [
      {
        duration: 2,
        layers: [audioLayer(clip1)],
        transition: new Transition({ name: "dummy", duration: fadeDuration }),
      },
      {
        duration: 2,
        layers: [audioLayer(clip2)],
      },
    ];

    const outPath = await runEdit(engine, clips);
    expect(outPath).toBeDefined();

    const wav = readWav(await toWav(outPath!));
    expect(wav.sampleRate).toBe(SAMPLE_RATE);

    // Two 2 s clips with 1 s overlap -> 3 s output, so the fade starts exactly at t = 1 s.
    expect(wav.frames.length / SAMPLE_RATE).toBeCloseTo(3, 2);

    const baseline = rms(wav.frames, SAMPLE_RATE * 0.4, SAMPLE_RATE * 0.8);
    expect(baseline).toBeGreaterThan(0);

    const windowSize = SAMPLE_RATE * 0.02; // 20 ms analysis windows

    // Equal-power rule: gOut(p) = cos(pi/2 p), gIn(p) = sin(pi/2 p).
    // For two equal-amplitude sines, mean-square energy inside the overlap is
    // gOut^2 * E + gIn^2 * E = E, so the RMS stays at the baseline everywhere.
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      const center = SAMPLE_RATE * (1 + p * fadeDuration);
      const measured = rms(wav.frames, center - windowSize / 2, center + windowSize / 2);
      const ratio = measured / baseline;
      expect(Math.abs(ratio - 1), `p=${p} measured ratio ${ratio}`).toBeLessThan(0.04);
    }

    // After the fade the second clip plays at full baseline level again.
    const tail = rms(wav.frames, SAMPLE_RATE * 2.4, SAMPLE_RATE * 2.8);
    expect(Math.abs(tail / baseline - 1)).toBeLessThan(0.04);
  });

  test("a zero-duration transition is a hard cut at the configured boundary", async () => {
    const clip1 = await makeSine("hard1.wav", 440, SAMPLE_RATE, 1);
    const clip2 = await makeSine("hard2.wav", 660, SAMPLE_RATE, 1);

    const engine = createAudioEngine({ verbose: false, tmpDir: workDir });
    const clips: Clip[] = [
      {
        duration: 1,
        layers: [audioLayer(clip1)],
        transition: new Transition({ duration: 0 }),
      },
      {
        duration: 1,
        layers: [audioLayer(clip2)],
      },
    ];

    const outPath = await runEdit(engine, clips);

    const wav = readWav(await toWav(outPath!));
    // No overlap: exact concatenation, total length is the sum of the inputs.
    expect(wav.frames.length / SAMPLE_RATE).toBeCloseTo(2, 2);

    // The first clip's tone must still be at full level right up to the boundary
    // (the previous implementation inserted an unintended ~1 s fade even at duration 0).
    const beforeBoundary = rms(wav.frames, SAMPLE_RATE * 0.8, SAMPLE_RATE * 0.95);
    const baseline = rms(wav.frames, SAMPLE_RATE * 0.2, SAMPLE_RATE * 0.6);
    expect(Math.abs(beforeBoundary / baseline - 1)).toBeLessThan(0.05);
  });

  test("inputs with different sample rates are unified before mixing", async () => {
    const lowRate = await makeSine("lowrate.wav", 440, 44100, 2);
    const highRate = await makeSine("highrate.wav", 660, 96000, 2);

    const engine = createAudioEngine({ verbose: false, tmpDir: workDir });
    const clips: Clip[] = [
      {
        duration: 2,
        layers: [audioLayer(lowRate), audioLayer(highRate)],
      },
    ];

    const outPath = await runEdit(engine, clips);

    const wav = readWav(await toWav(outPath!));
    expect(wav.sampleRate).toBe(SAMPLE_RATE);
    expect(wav.channels).toBe(2);
    // Both inputs are 2 s long; after unification the mix still spans ~2 s.
    expect(wav.frames.length / SAMPLE_RATE).toBeCloseTo(2, 2);
  });

  test("mixing does not attenuate by the number of inputs (envelope matches weights)", async () => {
    const track1 = await makeSine("mix1.wav", 440, SAMPLE_RATE, 2);
    const track2 = await makeSine("mix2.wav", 660, SAMPLE_RATE, 2);

    const engine = createAudioEngine({ verbose: false, tmpDir: workDir });
    const clips: Clip[] = [
      {
        duration: 2,
        layers: [audioLayer(track1, 1), audioLayer(track2, 1)],
      },
    ];

    const mixedPath = await runEdit(engine, clips);

    // Reference: a single track rendered through the same pipeline.
    const singleEngine = createAudioEngine({ verbose: false, tmpDir: workDir });
    const singlePath = await runEdit(singleEngine, [
      {
        duration: 2,
        layers: [audioLayer(track1)],
      },
    ]);

    const mixed = readWav(await toWav(mixedPath!));
    const single = readWav(await toWav(singlePath!));
    const mixedRms = rms(mixed.frames, SAMPLE_RATE * 0.5, SAMPLE_RATE * 1.5);
    const singleRms = rms(single.frames, SAMPLE_RATE * 0.5, SAMPLE_RATE * 1.5);

    // With normalize=0, two uncorrelated unit sines sum to sqrt(1^2 + 1^2) ~ 1.41x
    // the energy of one track. The old normalize=1 behavior yielded ~1.0x (each input
    // silently divided by 2), an audible volume jump compared with a single track.
    expect(mixedRms / singleRms).toBeGreaterThan(1.3);
    expect(mixedRms / singleRms).toBeLessThan(1.55);
  });

  test("a hard cut followed by a cross-fade share one correctly labeled graph", async () => {
    const c1 = await makeSine("chain1.wav", 330, SAMPLE_RATE, 1);
    const c2 = await makeSine("chain2.wav", 440, SAMPLE_RATE, 1);
    const c3 = await makeSine("chain3.wav", 660, SAMPLE_RATE, 1);

    const engine = createAudioEngine({ verbose: false, tmpDir: workDir });
    const clips: Clip[] = [
      {
        duration: 1,
        layers: [audioLayer(c1)],
        // No transition -> hard concat into clip 2
        transition: new Transition({ duration: 0 }),
      },
      {
        duration: 1,
        layers: [audioLayer(c2)],
        // 0.5 s equal-power cross-fade into clip 3
        transition: new Transition({ name: "dummy", duration: 0.5 }),
      },
      {
        duration: 1,
        layers: [audioLayer(c3)],
      },
    ];

    const outPath = await runEdit(engine, clips);

    const wav = readWav(await toWav(outPath!));
    // 1 + 1 + 1 minus the 0.5 s overlap (the hard cut removes nothing).
    expect(wav.frames.length / SAMPLE_RATE).toBeCloseTo(2.5, 2);

    const baseline = rms(wav.frames, SAMPLE_RATE * 0.2, SAMPLE_RATE * 0.7);
    // Equal-power region (1.5 s .. 2.0 s) stays at baseline level.
    for (const t of [1.55, 1.75, 1.95]) {
      const center = SAMPLE_RATE * t;
      const v = rms(wav.frames, center - SAMPLE_RATE * 0.01, center + SAMPLE_RATE * 0.01);
      expect(Math.abs(v / baseline - 1), `t=${t}`).toBeLessThan(0.05);
    }
  });

  test("arbitrary tracks with different sample rates are unified and summed", async () => {
    // The clip track determines output length; the arbitrary track starts at t=0.
    const clipTrack = await makeSine("arb-clip.wav", 440, SAMPLE_RATE, 2);
    const lowRate = await makeSine("arb-low.wav", 880, 44100, 2);

    const engine = createAudioEngine({ verbose: false, tmpDir: workDir });
    const outPath = await runEdit(
      engine,
      [
        {
          duration: 2,
          layers: [audioLayer(clipTrack)],
        },
      ],
      [{ path: lowRate.path, mixVolume: 1, cutFrom: 0, cutTo: 2, start: 0 }],
    );

    const wav = readWav(await toWav(outPath!));
    expect(wav.sampleRate).toBe(SAMPLE_RATE);
    expect(wav.channels).toBe(2);
    expect(wav.frames.length / SAMPLE_RATE).toBeCloseTo(2, 2);

    // Both unit sines present: summed energy ~ sqrt(2) x a single track's energy.
    const summedRms = rms(wav.frames, SAMPLE_RATE * 0.5, SAMPLE_RATE * 1.5);
    const singleEngine = createAudioEngine({ verbose: false, tmpDir: workDir });
    const singlePath = await runEdit(singleEngine, [
      {
        duration: 2,
        layers: [audioLayer(clipTrack)],
      },
    ]);
    const single = readWav(await toWav(singlePath!));
    const singleRms = rms(single.frames, SAMPLE_RATE * 0.5, SAMPLE_RATE * 1.5);
    expect(summedRms / singleRms).toBeGreaterThan(1.3);
    expect(summedRms / singleRms).toBeLessThan(1.55);
  });

  test("single-track output is passed through unchanged", async () => {
    const only = await makeSine("single.wav", 440, SAMPLE_RATE, 1.5);

    const engine = createAudioEngine({ verbose: false, tmpDir: workDir });
    const outPath = await runEdit(engine, [
      {
        duration: 1.5,
        layers: [audioLayer(only)],
      },
    ]);

    // Single layer + single clip: the extracted file is returned as-is (no remix).
    expect(outPath).toMatch(/clip0-layer0-audio\.flac$/);
    const wav = readWav(await toWav(outPath!));
    expect(wav.sampleRate).toBe(SAMPLE_RATE);
    expect(wav.channels).toBe(2);
    expect(wav.frames.length / SAMPLE_RATE).toBeCloseTo(1.5, 2);
  });
});
