/**
 * Frame-exact timeline computation.
 *
 * All clip/transition timing is resolved here, in the frame domain, so that the
 * video frame schedule, the audio crossfades and detached audio offsets all agree
 * exactly. A clip with `duration` seconds renders `round(duration * fps)` frames.
 * A transition overlaps the LAST `transitionNumFrames` frames of its clip with the
 * FIRST `transitionNumFrames` frames of the next clip.
 */

export type TimelineClipInput = {
  /** Clip duration in seconds. */
  duration: number;
  /** Requested duration (seconds) of the transition from this clip to the next. */
  transitionDuration?: number;
};

export type ClipTimeline = {
  /** How many frames this clip renders (locally), `round(duration * fps)`. */
  numFrames: number;
  /**
   * How many frames the transition to the next clip spans.
   * Clamped to at most half of each of the two adjacent clips, so that a clip can
   * never be completely consumed by its two transitions. Always 0 for the last clip.
   */
  transitionNumFrames: number;
  /** Output frame index at which this clip's local frame 0 is rendered. */
  startFrame: number;
  /** Output frame index at which the transition to the next clip starts. */
  transitionStartFrame: number;
};

export type Timeline = {
  clips: ClipTimeline[];
  /** Total number of output frames. */
  totalFrames: number;
};

export function getClipNumFrames(duration: number, fps: number) {
  return Math.round(duration * fps);
}

/**
 * The transition duration (in seconds) that is safe to use between two clips,
 * i.e. clamped to half the duration of the shorter of the two clips.
 */
export function getSafeTransitionDuration({
  transitionDuration,
  clipDuration,
  nextClipDuration,
}: {
  transitionDuration: number;
  clipDuration: number;
  nextClipDuration?: number;
}) {
  if (nextClipDuration == null) return 0;
  // Each clip can have two transitions, make sure we leave enough room:
  return Math.min(transitionDuration, clipDuration / 2, nextClipDuration / 2);
}

/**
 * The transition length in frames. Clamping is done in the frame domain (and only
 * here) so every consumer of the timeline observes the exact same transition span.
 */
export function getSafeTransitionNumFrames({
  transitionDuration,
  clipNumFrames,
  nextClipNumFrames,
  fps,
}: {
  transitionDuration: number;
  clipNumFrames: number;
  nextClipNumFrames?: number;
  fps: number;
}) {
  if (nextClipNumFrames == null) return 0;
  // Each clip can have two transitions, make sure we leave enough room:
  return Math.max(
    0,
    Math.min(
      Math.round(transitionDuration * fps),
      Math.floor(clipNumFrames / 2),
      Math.floor(nextClipNumFrames / 2),
    ),
  );
}

/**
 * Compute the frame-exact timeline for a list of clips.
 */
export function computeTimeline(clips: TimelineClipInput[], fps: number): Timeline {
  let startFrame = 0;

  const timelineClips = clips.map((clip, i) => {
    const numFrames = getClipNumFrames(clip.duration, fps);
    const nextClip = clips[i + 1];

    const transitionNumFrames = getSafeTransitionNumFrames({
      transitionDuration: clip.transitionDuration ?? 0,
      clipNumFrames: numFrames,
      nextClipNumFrames: nextClip ? getClipNumFrames(nextClip.duration, fps) : undefined,
      fps,
    });

    const clipTimeline: ClipTimeline = {
      numFrames,
      transitionNumFrames,
      startFrame,
      transitionStartFrame: startFrame + numFrames - transitionNumFrames,
    };

    startFrame += numFrames - transitionNumFrames;

    return clipTimeline;
  });

  return { clips: timelineClips, totalFrames: startFrame };
}

export type FrameScheduleEntry = {
  /** Index of the clip currently being rendered. */
  fromClipIndex: number;
  /** Local frame index of the frame to render from `fromClipIndex`. */
  fromClipFrame: number;
  /** During a transition: index of the next clip, otherwise `null`. */
  toClipIndex: number | null;
  /** During a transition: local frame index of the frame to render from the next clip. */
  toClipFrame: number | null;
  /** Total number of frames in the current transition (0 when not in a transition). */
  transitionNumFrames: number;
};

/**
 * Generate the exact output frame schedule: one entry per output frame, in order.
 *
 * Each clip renders its local frames `[incomingTransitionFrames, numFrames)` as the
 * "from" clip; its first `incomingTransitionFrames` frames were already rendered as
 * the "to" clip of the previous clip's transition. During a transition, the last
 * `transitionNumFrames` frames of a clip are blended with the first
 * `transitionNumFrames` frames of the next clip.
 */
export function* generateFrameSchedule(timelineClips: ClipTimeline[]): Generator<FrameScheduleEntry> {
  // How many frames of the current clip were already rendered as the previous
  // clip's transition target:
  let consumedFrames = 0;

  for (let clipIndex = 0; clipIndex < timelineClips.length; clipIndex += 1) {
    const { numFrames, transitionNumFrames } = timelineClips[clipIndex];
    const isLastClip = clipIndex === timelineClips.length - 1;

    for (let frame = consumedFrames; frame < numFrames; frame += 1) {
      // How many frames into the transition are we? negative means not yet started
      const transitionFrameAt = frame - (numFrames - transitionNumFrames);
      const isInTransition = !isLastClip && transitionNumFrames > 0 && transitionFrameAt >= 0;

      yield {
        fromClipIndex: clipIndex,
        fromClipFrame: frame,
        toClipIndex: isInTransition ? clipIndex + 1 : null,
        toClipFrame: isInTransition ? transitionFrameAt : null,
        transitionNumFrames: isInTransition ? transitionNumFrames : 0,
      };
    }

    consumedFrames = transitionNumFrames;
  }
}
