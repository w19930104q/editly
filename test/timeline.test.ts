import { describe, expect, test } from "vitest";
import { FrameSource } from "../src/api/defineFrameSource.js";
import {
  computeTimeline,
  generateFrameSchedule,
  getSafeTransitionDuration,
} from "../src/timeline.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyData = any;

const clip = (duration: number, transitionDuration = 0) => ({
  duration,
  transitionDuration,
});

describe("computeTimeline", () => {
  test("single clip without transition", () => {
    const timeline = computeTimeline([clip(2)], 25);
    expect(timeline.clips).toEqual([
      { numFrames: 50, transitionNumFrames: 0, startFrame: 0, transitionStartFrame: 50 },
    ]);
    expect(timeline.totalFrames).toBe(50);
  });

  test("last clip never has a transition", () => {
    const timeline = computeTimeline([clip(2, 0.5), clip(1, 0.5)], 25);
    expect(timeline.clips[1].transitionNumFrames).toBe(0);
    // 0.5s @ 25fps rounds to 13 frames, clamped to half of the 1s clip -> 12
    expect(timeline.clips[0].transitionNumFrames).toBe(12);
    expect(timeline.totalFrames).toBe(50 + 25 - 12);
  });

  test("transition overlaps the end of a clip with the start of the next", () => {
    const timeline = computeTimeline([clip(2, 0.5), clip(2, 0.5), clip(1)], 25);

    expect(timeline.clips.map((c) => c.numFrames)).toEqual([50, 50, 25]);
    // 0.5s @ 25fps = 12.5 -> rounds to 13, but clamped to half of the 1s clip (12)
    expect(timeline.clips.map((c) => c.transitionNumFrames)).toEqual([13, 12, 0]);

    // Each clip starts where the previous clip's transition started
    expect(timeline.clips[0].startFrame).toBe(0);
    expect(timeline.clips[0].transitionStartFrame).toBe(50 - 13);
    expect(timeline.clips[1].startFrame).toBe(50 - 13);
    expect(timeline.clips[1].transitionStartFrame).toBe(50 - 13 + 50 - 12);
    expect(timeline.clips[2].startFrame).toBe(50 - 13 + 50 - 12);

    expect(timeline.totalFrames).toBe(50 + 50 + 25 - 13 - 12);
  });

  test("transition is clamped to half of the shorter adjacent clip", () => {
    const timeline = computeTimeline([clip(1, 5), clip(0.2)], 30);
    expect(timeline.clips[0].numFrames).toBe(30);
    expect(timeline.clips[1].numFrames).toBe(6);
    // min(5s requested, 15 frames, 3 frames)
    expect(timeline.clips[0].transitionNumFrames).toBe(3);
    expect(timeline.totalFrames).toBe(30 + 6 - 3);
  });

  test("transition longer than the clips never eats a whole clip", () => {
    const timeline = computeTimeline([clip(1, 10), clip(1, 10), clip(1)], 25);
    for (const c of timeline.clips) {
      expect(c.transitionNumFrames).toBeLessThanOrEqual(Math.floor(c.numFrames / 2));
    }
    expect(timeline.clips[0].transitionNumFrames).toBe(12);
    expect(timeline.clips[1].transitionNumFrames).toBe(12);
  });

  test("zero duration transition produces no overlap", () => {
    const timeline = computeTimeline([clip(1, 0), clip(1)], 25);
    expect(timeline.clips[0].transitionNumFrames).toBe(0);
    expect(timeline.totalFrames).toBe(50);
  });

  test("non-integer frame counts are rounded consistently", () => {
    const timeline = computeTimeline([clip(0.7, 0.3), clip(0.7)], 25);
    // 0.7 * 25 = 17.5 -> 18 frames
    expect(timeline.clips.map((c) => c.numFrames)).toEqual([18, 18]);
    // 0.3 * 25 = 7.5 -> 8 frames
    expect(timeline.clips[0].transitionNumFrames).toBe(8);
    expect(timeline.totalFrames).toBe(18 + 18 - 8);
  });
});

describe("generateFrameSchedule", () => {
  test("every output frame maps to exact clip frames", () => {
    // 2 clips of 1s @ 10fps, 0.4s (4 frame) transition
    const timeline = computeTimeline([clip(1, 0.4), clip(1)], 10);
    const schedule = [...generateFrameSchedule(timeline.clips)];

    expect(schedule).toEqual([
      // clip 0 exclusive frames
      { fromClipIndex: 0, fromClipFrame: 0, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 0, fromClipFrame: 1, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 0, fromClipFrame: 2, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 0, fromClipFrame: 3, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 0, fromClipFrame: 4, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 0, fromClipFrame: 5, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      // transition: last 4 frames of clip 0 blended with first 4 frames of clip 1
      { fromClipIndex: 0, fromClipFrame: 6, toClipIndex: 1, toClipFrame: 0, transitionNumFrames: 4 },
      { fromClipIndex: 0, fromClipFrame: 7, toClipIndex: 1, toClipFrame: 1, transitionNumFrames: 4 },
      { fromClipIndex: 0, fromClipFrame: 8, toClipIndex: 1, toClipFrame: 2, transitionNumFrames: 4 },
      { fromClipIndex: 0, fromClipFrame: 9, toClipIndex: 1, toClipFrame: 3, transitionNumFrames: 4 },
      // clip 1 resumes after the frames already rendered by the transition
      { fromClipIndex: 1, fromClipFrame: 4, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 1, fromClipFrame: 5, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 1, fromClipFrame: 6, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 1, fromClipFrame: 7, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 1, fromClipFrame: 8, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
      { fromClipIndex: 1, fromClipFrame: 9, toClipIndex: null, toClipFrame: null, transitionNumFrames: 0 },
    ]);
  });

  // Frame-level schedule checked item by item against the configuration, for a
  // variety of transition durations and clip duration combinations.
  describe.each([
    { durations: [2, 2, 1], transition: 0.5, fps: 25 },
    { durations: [2, 2, 1], transition: 0, fps: 25 },
    { durations: [1, 1], transition: 5, fps: 30 },
    { durations: [0.7, 0.3, 1.1, 0.5], transition: 0.4, fps: 25 },
    { durations: [4, 0.5, 0.5, 4], transition: 1, fps: 30 },
    { durations: [1.5, 2.5], transition: 0.333, fps: 24 },
    { durations: [3], transition: 0.5, fps: 25 },
  ])("clips $durations, transition $transition s, $fps fps", ({ durations, transition, fps }) => {
    const clips = durations.map((duration) => clip(duration, transition));
    const timeline = computeTimeline(clips, fps);
    const schedule = [...generateFrameSchedule(timeline.clips)];

    test("total frames match the timeline", () => {
      expect(schedule.length).toBe(timeline.totalFrames);
      const expectedTotal =
        timeline.clips.reduce((acc, c) => acc + c.numFrames, 0) -
        timeline.clips.reduce((acc, c) => acc + c.transitionNumFrames, 0);
      expect(schedule.length).toBe(expectedTotal);
    });

    test("each clip renders exactly its local frames, exactly once", () => {
      // Collect, for every clip, which of its local frames appear in the output
      // (either as the "from" clip or as a transition's "to" clip)
      const renderedFrames: number[][] = clips.map(() => []);
      for (const entry of schedule) {
        renderedFrames[entry.fromClipIndex].push(entry.fromClipFrame);
        if (entry.toClipIndex != null) renderedFrames[entry.toClipIndex].push(entry.toClipFrame!);
      }
      timeline.clips.forEach((clipTimeline, i) => {
        expect(renderedFrames[i].sort((a, b) => a - b)).toEqual(
          Array.from({ length: clipTimeline.numFrames }, (_, f) => f),
        );
      });
    });

    test("clip i starts exactly where clip i-1's transition starts", () => {
      let outputFrame = 0;
      timeline.clips.forEach((clipTimeline, i) => {
        expect(clipTimeline.startFrame).toBe(outputFrame);
        expect(clipTimeline.transitionStartFrame).toBe(
          clipTimeline.startFrame + clipTimeline.numFrames - clipTimeline.transitionNumFrames,
        );
        outputFrame += clipTimeline.numFrames - clipTimeline.transitionNumFrames;
        void i;
      });
      expect(outputFrame).toBe(timeline.totalFrames);
    });

    test("transition covers the last T frames of a clip and the first T of the next", () => {
      timeline.clips.forEach((clipTimeline, i) => {
        const T = clipTimeline.transitionNumFrames;
        const transitionEntries = schedule.filter((e) => e.fromClipIndex === i && e.toClipIndex != null);

        expect(transitionEntries.length).toBe(T);
        // The transition spans the LAST T frames of clip i ...
        expect(transitionEntries.map((e) => e.fromClipFrame)).toEqual(
          Array.from({ length: T }, (_, k) => clipTimeline.numFrames - T + k),
        );
        // ... and the FIRST T frames of clip i+1, in lockstep
        expect(transitionEntries.map((e) => e.toClipFrame)).toEqual(
          Array.from({ length: T }, (_, k) => k),
        );
        expect(transitionEntries.every((e) => e.toClipIndex === i + 1)).toBe(true);
        expect(transitionEntries.every((e) => e.transitionNumFrames === T)).toBe(true);

        // The transition occupies exactly the output frames
        // [transitionStartFrame, transitionStartFrame + T)
        const firstTransitionEntry = schedule.findIndex(
          (e) => e.fromClipIndex === i && e.toClipIndex != null,
        );
        if (T > 0) expect(firstTransitionEntry).toBe(clipTimeline.transitionStartFrame);
      });
    });

    test("from-frames of each clip are contiguous and continue after its incoming transition", () => {
      timeline.clips.forEach((clipTimeline, i) => {
        const fromEntries = schedule.filter((e) => e.fromClipIndex === i);
        const incomingTransition = i === 0 ? 0 : timeline.clips[i - 1].transitionNumFrames;
        expect(fromEntries.map((e) => e.fromClipFrame)).toEqual(
          Array.from(
            { length: clipTimeline.numFrames - incomingTransition },
            (_, k) => incomingTransition + k,
          ),
        );
      });
    });
  });
});

describe("getSafeTransitionDuration", () => {
  test("clamps to half of the shorter clip", () => {
    expect(
      getSafeTransitionDuration({ transitionDuration: 5, clipDuration: 2, nextClipDuration: 1 }),
    ).toBe(0.5);
    expect(
      getSafeTransitionDuration({ transitionDuration: 0.4, clipDuration: 2, nextClipDuration: 1 }),
    ).toBe(0.4);
    expect(getSafeTransitionDuration({ transitionDuration: 5, clipDuration: 2 })).toBe(0);
  });
});

describe("FrameSource layer start/stop timing", () => {
  async function getDrawnFrames({
    start,
    stop,
    clipDuration,
    fps,
  }: {
    start?: number;
    stop?: number;
    clipDuration: number;
    fps: number;
  }) {
    const drawnFrames: number[] = [];
    let currentFrame = 0;
    const layerDuration = (stop ?? clipDuration) - (start ?? 0);
    const frameSource = new FrameSource(
      {
        width: 16,
        height: 16,
        channels: 4,
        duration: clipDuration,
        framerateStr: String(fps),
        params: { type: "fill-color", start, stop, layerDuration },
      } as AnyData,
      {
        readNextFrame: () => {
          drawnFrames.push(currentFrame);
        },
      },
    );
    const numFrames = Math.round(clipDuration * fps);
    for (let frame = 0; frame < numFrames; frame += 1) {
      currentFrame = frame;
      await frameSource.readNextFrame(frame / fps, undefined as AnyData);
    }
    return drawnFrames;
  }

  test("layer is drawn exactly on frames [start, stop)", async () => {
    // 3s clip @ 25fps, layer from 1s to 2s -> frames 25..49 (exactly 25 frames)
    expect(await getDrawnFrames({ start: 1, stop: 2, clipDuration: 3, fps: 25 })).toEqual(
      Array.from({ length: 25 }, (_, f) => 25 + f),
    );
  });

  test("adjacent layers neither overlap nor leave a gap", async () => {
    const fps = 25;
    const clipDuration = 2;
    const layerA = await getDrawnFrames({ start: 0, stop: 1, clipDuration, fps });
    const layerB = await getDrawnFrames({ start: 1, stop: 2, clipDuration, fps });

    expect(layerA).toEqual(Array.from({ length: 25 }, (_, f) => f));
    expect(layerB).toEqual(Array.from({ length: 25 }, (_, f) => 25 + f));
    expect([...layerA, ...layerB]).toEqual(Array.from({ length: 50 }, (_, f) => f));
  });

  test("full-duration layer is drawn on every frame", async () => {
    expect(await getDrawnFrames({ clipDuration: 2, fps: 25 })).toHaveLength(50);
    expect(await getDrawnFrames({ start: 0, stop: 2, clipDuration: 2, fps: 25 })).toHaveLength(50);
  });

  test("boundaries are exact even when clip duration is not a whole number of frames", async () => {
    // 0.7s @ 25fps -> 18 frames; layer stop=0.4 -> exactly frames 0..9
    expect(await getDrawnFrames({ start: 0, stop: 0.4, clipDuration: 0.7, fps: 25 })).toEqual(
      Array.from({ length: 10 }, (_, f) => f),
    );
    // layer start=0.4 -> exactly frames 10..17
    expect(await getDrawnFrames({ start: 0.4, clipDuration: 0.7, fps: 25 })).toEqual(
      Array.from({ length: 8 }, (_, f) => 10 + f),
    );
  });
});
