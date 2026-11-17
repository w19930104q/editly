import assert from "assert";
import { flatMap } from "lodash-es";
import type { TransitionOptions } from "./transition.js";
import type { AudioNormalizationOptions, AudioTrack } from "./types.js";

/**
 * Pure ffmpeg command builders.
 *
 * This module is the "build layer" of ffmpeg invocation: every function is pure
 * (no I/O, no process spawning, no logging) and maps a plain options object to
 * an ffmpeg argument array (or filter string). The "execution layer" lives in
 * `ffmpeg.ts`, which only runs the built commands and handles logging.
 *
 * Because these functions are pure, their output can be unit-tested without
 * running ffmpeg or rendering anything.
 */

// ---------------------------------------------------------------------------
// Generic argument helpers
// ---------------------------------------------------------------------------

export function getFfmpegCommonArgs({
  enableFfmpegLog,
}: {
  enableFfmpegLog: boolean;
}): string[] {
  return ["-hide_banner", ...(enableFfmpegLog ? [] : ["-loglevel", "error"])];
}

export function getCutFromArgs({ cutFrom }: { cutFrom?: number }): string[] {
  return cutFrom ? ["-ss", cutFrom.toString()] : [];
}

export function getCutToArgs({
  cutTo,
  cutFrom,
  speedFactor,
}: {
  cutTo?: number;
  cutFrom?: number;
  speedFactor: number;
}) {
  return cutFrom && cutTo ? ["-t", (cutTo - cutFrom) * speedFactor] : [];
}

// ---------------------------------------------------------------------------
// Audio commands
// ---------------------------------------------------------------------------

/**
 * Arguments to generate a silent stereo FLAC of the given duration.
 */
export function buildSilenceAudioArgs({
  duration,
  outPath,
}: {
  duration: number;
  outPath: string;
}): string[] {
  return [
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-sample_fmt",
    "s32",
    "-ar",
    "48000",
    "-t",
    duration.toString(),
    "-c:a",
    "flac",
    "-y",
    outPath,
  ];
}

/**
 * Returns the atempo value needed to compensate a speed factor,
 * or `undefined` when the speed is (nearly) unchanged.
 */
export function calcAtempo(speedFactor: number): number | undefined {
  if (Math.abs(speedFactor - 1) <= 0.01) return undefined;
  return 1 / speedFactor;
}

/**
 * ffmpeg requires atempo to be within [0.5, 100].
 */
export function isAtempoInRange(atempo: number): boolean {
  return atempo >= 0.5 && atempo <= 100;
}

/**
 * Arguments to extract (and optionally re-tempo) the audio of a layer into a FLAC file.
 */
export function buildExtractAudioArgs({
  path,
  cutFrom,
  cutTo,
  speedFactor,
  atempoFilter,
  outPath,
}: {
  path: string;
  cutFrom: number;
  cutTo: number;
  speedFactor: number;
  atempoFilter?: string;
  outPath: string;
}): string[] {
  const cutToArg = (cutTo - cutFrom) * speedFactor;

  return [
    "-nostdin",
    ...getCutFromArgs({ cutFrom }),
    "-i",
    path,
    "-t",
    cutToArg.toString(),
    "-sample_fmt",
    "s32",
    "-ar",
    "48000",
    "-map",
    "a:0",
    "-c:a",
    "flac",
    ...(atempoFilter ? ["-filter:a", atempoFilter] : []),
    "-y",
    outPath,
  ];
}

/**
 * Arguments to mix several audio files into one, using the amix filter.
 */
export function buildAmixArgs({
  inputPaths,
  weights,
  outPath,
}: {
  inputPaths: string[];
  weights: (number | string)[];
  outPath: string;
}): string[] {
  return [
    "-nostdin",
    ...flatMap(inputPaths, (inputPath) => ["-i", inputPath]),
    "-filter_complex",
    `amix=inputs=${inputPaths.length}:duration=longest:weights=${weights.join(" ")}`,
    "-c:a",
    "flac",
    "-y",
    outPath,
  ];
}

/**
 * Filter graph that concatenates clip audio with cross fades between them.
 */
export function buildCrossFadeFilterGraph(
  clipAudio: { transition?: TransitionOptions | null }[],
): string {
  let inStream = "[0:a]";
  return clipAudio
    .slice(0, -1)
    .map(({ transition }, i) => {
      const outStream = `[concat${i}]`;

      const epsilon = 0.0001; // If duration is 0, ffmpeg seems to default to 1 sec instead, hence epsilon.
      let ret = `${inStream}[${i + 1}:a]acrossfade=d=${Math.max(epsilon, transition?.duration ?? 0)}:c1=${transition?.audioOutCurve ?? "tri"}:c2=${transition?.audioInCurve ?? "tri"}`;

      inStream = outStream;

      if (i < clipAudio.length - 2) ret += outStream;
      return ret;
    })
    .join(",");
}

/**
 * Arguments to concatenate clip audio files with cross fades into a single FLAC file.
 */
export function buildCrossFadeConcatArgs({
  clipAudio,
  outPath,
}: {
  clipAudio: { path: string; transition?: TransitionOptions | null }[];
  outPath: string;
}): string[] {
  return [
    "-nostdin",
    ...flatMap(clipAudio, ({ path }) => ["-i", path]),
    "-filter_complex",
    buildCrossFadeFilterGraph(clipAudio),
    "-c",
    "flac",
    "-y",
    outPath,
  ];
}

/**
 * Filter complex that trims/delays/pads all audio streams and mixes them together,
 * with optional audio normalization and output volume adjustment.
 */
export function buildMixArbitraryAudioFilterComplex({
  streams,
  audioNorm,
  outputVolume,
}: {
  streams: (AudioTrack & { loop?: number })[];
  audioNorm?: AudioNormalizationOptions;
  outputVolume?: number | string;
}): string {
  let maxGain = 30;
  let gaussSize = 5;
  if (audioNorm) {
    if (audioNorm.gaussSize != null) gaussSize = audioNorm.gaussSize;
    if (audioNorm.maxGain != null) maxGain = audioNorm.maxGain;
  }
  const enableAudioNorm = audioNorm && audioNorm.enable;

  // https://stackoverflow.com/questions/35509147/ffmpeg-amix-filter-volume-issue-with-inputs-of-different-duration
  let filterComplex = streams
    .map(({ start, cutFrom, cutTo }, i) => {
      const cutToArg = cutTo != null ? `:end=${cutTo}` : "";
      const apadArg = i > 0 ? ",apad" : ""; // Don't pad the first track (audio from video clips with correct duration)

      return `[${i}:a]atrim=start=${cutFrom || 0}${cutToArg},adelay=delays=${Math.floor((start || 0) * 1000)}:all=1${apadArg}[a${i}]`;
    })
    .join(";");

  const volumeArg = outputVolume != null ? `,volume=${outputVolume}` : "";
  const audioNormArg = enableAudioNorm ? `,dynaudnorm=g=${gaussSize}:maxgain=${maxGain}` : "";
  filterComplex += `;${streams.map((_, i) => `[a${i}]`).join("")}amix=inputs=${streams.length}:duration=first:dropout_transition=0:weights=${streams.map((s) => (s.mixVolume != null ? s.mixVolume : 1)).join(" ")}${audioNormArg}${volumeArg}`;

  return filterComplex;
}

/**
 * Arguments to mix the concatenated clip audio with arbitrary (user supplied) audio tracks.
 */
export function buildMixArbitraryAudioArgs({
  streams,
  audioNorm,
  outputVolume,
  outPath,
}: {
  streams: (AudioTrack & { loop?: number })[];
  audioNorm?: AudioNormalizationOptions;
  outputVolume?: number | string;
  outPath: string;
}): string[] {
  return [
    "-nostdin",
    ...flatMap(streams, ({ path, loop }) => ["-stream_loop", (loop || 0).toString(), "-i", path]),
    "-vn",
    "-filter_complex",
    buildMixArbitraryAudioFilterComplex({ streams, audioNorm, outputVolume }),
    "-c:a",
    "flac",
    "-y",
    outPath,
  ];
}

// ---------------------------------------------------------------------------
// Video frame source commands
// ---------------------------------------------------------------------------

/**
 * Calculates the scale (and crop) filter used to fit a video layer onto the canvas,
 * according to the resize mode. Also returns the resulting frame dimensions.
 */
export function buildScaleFilter({
  resizeMode,
  requestedWidth,
  requestedHeight,
  inputWidth,
  inputHeight,
}: {
  resizeMode: string;
  requestedWidth: number;
  requestedHeight: number;
  inputWidth: number;
  inputHeight: number;
}): { scaleFilter: string; targetWidth: number; targetHeight: number } {
  const ratioW = requestedWidth / inputWidth;
  const ratioH = requestedHeight / inputHeight;
  const inputAspectRatio = inputWidth / inputHeight;

  let targetWidth = requestedWidth;
  let targetHeight = requestedHeight;

  let scaleFilter;
  if (["contain", "contain-blur"].includes(resizeMode)) {
    if (ratioW > ratioH) {
      targetHeight = requestedHeight;
      targetWidth = Math.round(requestedHeight * inputAspectRatio);
    } else {
      targetWidth = requestedWidth;
      targetHeight = Math.round(requestedWidth / inputAspectRatio);
    }

    scaleFilter = `scale=${targetWidth}:${targetHeight}`;
  } else if (resizeMode === "cover") {
    let scaledWidth;
    let scaledHeight;

    if (ratioW > ratioH) {
      scaledWidth = requestedWidth;
      scaledHeight = Math.round(requestedWidth / inputAspectRatio);
    } else {
      scaledHeight = requestedHeight;
      scaledWidth = Math.round(requestedHeight * inputAspectRatio);
    }

    // TODO improve performance by crop first, then scale?
    scaleFilter = `scale=${scaledWidth}:${scaledHeight},crop=${targetWidth}:${targetHeight}`;
  } else {
    // 'stretch'
    scaleFilter = `scale=${targetWidth}:${targetHeight}`;
  }

  return { scaleFilter, targetWidth, targetHeight };
}

/**
 * Returns the setpts filter prefix used to speed up/slow down video,
 * or an empty string when the speed is unchanged.
 */
export function buildPtsFilter(speedFactor: number): string {
  return speedFactor !== 1 ? `setpts=${speedFactor}*PTS,` : "";
}

/**
 * Maps a codec name to the ffmpeg decoder needed to read alpha-channel videos.
 * https://forum.unity.com/threads/settings-for-importing-a-video-with-an-alpha-channel.457657/
 */
export function getVideoInputCodec(codecName?: string): string | undefined {
  // https://superuser.com/a/1116905/658247
  if (codecName === "vp8") return "libvpx";
  if (codecName === "vp9") return "libvpx-vp9";
  return undefined;
}

/**
 * Arguments to decode a video file into a raw RGBA frame stream on stdout.
 */
export function buildVideoFrameSourceArgs({
  path,
  inputCodec,
  cutFrom,
  cutTo,
  speedFactor,
  framerateStr,
  scaleFilter,
}: {
  path: string;
  inputCodec?: string;
  cutFrom?: number;
  cutTo?: number;
  speedFactor: number;
  framerateStr: string;
  scaleFilter: string;
}): string[] {
  // http://zulko.github.io/blog/2013/09/27/read-and-write-video-frames-in-python-using-ffmpeg/
  // Testing: ffmpeg -i 'vid.mov' -t 1 -vcodec rawvideo -pix_fmt rgba -f image2pipe - | ffmpeg -f rawvideo -vcodec rawvideo -pix_fmt rgba -s 2166x1650 -i - -vf format=yuv420p -vcodec libx264 -y out.mp4
  // https://trac.ffmpeg.org/wiki/ChangingFrameRate
  return [
    "-nostdin",
    ...(inputCodec ? ["-vcodec", inputCodec] : []),
    ...(cutFrom ? ["-ss", cutFrom.toString()] : []),
    "-i",
    path,
    ...(cutTo ? ["-t", ((cutTo - cutFrom!) * speedFactor).toString()] : []),
    "-vf",
    `${buildPtsFilter(speedFactor)}fps=${framerateStr},${scaleFilter}`,
    "-map",
    "v:0",
    "-vcodec",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-f",
    "image2pipe",
    "-",
  ];
}

// ---------------------------------------------------------------------------
// Output (writer) commands
// ---------------------------------------------------------------------------

/**
 * Arguments controlling the output codecs/format of the final render.
 */
export function buildOutputArgs({
  isGif,
  fps,
  width,
  height,
  fast,
  hasAudio,
  customOutputArgs,
}: {
  isGif?: boolean;
  fps: number;
  width: number;
  height: number;
  fast?: boolean;
  hasAudio: boolean;
  customOutputArgs?: string[];
}): string[] {
  if (customOutputArgs) {
    assert(Array.isArray(customOutputArgs), "customOutputArgs must be an array of arguments");
    return customOutputArgs;
  }

  // https://superuser.com/questions/556029/how-do-i-convert-a-video-to-gif-using-ffmpeg-with-reasonable-quality
  const videoOutputArgs = isGif
    ? [
        "-vf",
        `format=rgb24,fps=${fps},scale=${width}:${height}:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
        "-loop",
        "0",
      ]
    : [
        "-vf",
        "format=yuv420p",
        "-vcodec",
        "libx264",
        "-profile:v",
        "high",
        ...(fast ? ["-preset:v", "ultrafast"] : ["-preset:v", "medium"]),
        "-crf",
        "18",

        "-movflags",
        "faststart",
      ];

  const audioOutputArgs = hasAudio ? ["-acodec", "aac", "-b:a", "128k"] : [];

  return [...audioOutputArgs, ...videoOutputArgs];
}

/**
 * Arguments for the long-running ffmpeg process that consumes raw RGBA frames
 * on stdin and writes the final output file.
 */
export function buildWriterArgs({
  width,
  height,
  framerateStr,
  audioFilePath,
  isGif,
  outputArgs,
  outPath,
}: {
  width: number;
  height: number;
  framerateStr: string;
  audioFilePath?: string;
  isGif?: boolean;
  outputArgs: string[];
  outPath: string;
}): string[] {
  return [
    "-f",
    "rawvideo",
    "-vcodec",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${width}x${height}`,
    "-r",
    framerateStr,
    "-i",
    "-",

    ...(audioFilePath ? ["-i", audioFilePath] : []),

    ...(!isGif ? ["-map", "0:v:0"] : []),
    ...(audioFilePath ? ["-map", "1:a:0"] : []),

    ...outputArgs,

    "-y",
    outPath,
  ];
}
