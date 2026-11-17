import { flatMap } from "lodash-es";
import pMap from "p-map";
import { basename, join, resolve } from "path";
import type { Configuration } from "./configuration.js";
import { ffmpeg, getCutFromArgs, readFileStreams } from "./ffmpeg.js";
import type { TransitionOptions } from "./transition.js";
import type {
  AudioLayer,
  AudioNormalizationOptions,
  AudioTrack,
  Clip,
  VideoLayer,
} from "./types.js";

export type AudioOptions = {
  verbose: boolean;
  tmpDir: string;
};

export type EditAudioOptions = Pick<
  Configuration,
  "keepSourceAudio" | "clips" | "clipsAudioVolume" | "audioNorm" | "outputVolume"
> & {
  arbitraryAudio: AudioTrack[];
};

type LayerWithAudio = (AudioLayer | VideoLayer) & { speedFactor: number };

// ffmpeg `amix` scales each input down by 1/input-count by default (normalize=1),
// which makes the rendered level depend on how many tracks happen to be active and
// causes audible volume jumps when tracks start/stop. We always want a plain sum,
// weighted by the user-configured mixVolume.
const AMIX_NORMALIZE = 0;

// Equal-power cross fade: outgoing gain cos(pi/2*p), incoming gain sin(pi/2*p),
// so g1^2 + g2^2 = 1 throughout the overlap and the total energy stays constant
// (ffmpeg's `qsin` curve implements exactly these gain ramps).
const DEFAULT_AUDIO_OUT_CURVE = "qsin";
const DEFAULT_AUDIO_IN_CURVE = "qsin";

// Sample rate that every input is converted to before any mixing/cross-fading,
// so inputs with differing sample rates are unified on a common clock first.
const MIX_SAMPLE_RATE = 48000;

function parseVolume(volume: number | string | undefined, fallback = 1): number {
  if (volume == null || volume === "") return fallback;
  const parsed = typeof volume === "number" ? volume : Number.parseFloat(volume);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default ({ verbose, tmpDir }: AudioOptions) => {
  async function createMixedAudioClips({
    clips,
    keepSourceAudio,
  }: {
    clips: Clip[];
    keepSourceAudio?: boolean;
  }) {
    return pMap(
      clips,
      async (clip, i) => {
        const { duration, layers, transition } = clip;

        async function runInner(): Promise<{ clipAudioPath: string; silent: boolean }> {
          const clipAudioPath = join(tmpDir, `clip${i}-audio.flac`);

          async function createSilence() {
            if (verbose) console.log("create silence", duration);
            const args = [
              "-nostdin",
              "-f",
              "lavfi",
              "-i",
              `anullsrc=channel_layout=stereo:sample_rate=${MIX_SAMPLE_RATE}`,
              "-sample_fmt",
              "s32",
              "-ar",
              MIX_SAMPLE_RATE.toString(),
              "-ac",
              "2",
              "-t",
              duration!.toString(),
              "-c:a",
              "flac",
              "-y",
              clipAudioPath,
            ];
            await ffmpeg(args);

            return { silent: true, clipAudioPath };
          }

          // Has user enabled keep source audio?
          if (!keepSourceAudio) return createSilence();

          // TODO:[ts]: Layers is always an array once config is parsed. Fix this in types
          const audioLayers = layers.filter(
            ({ type, start, stop }) =>
              ["audio", "video"].includes(type) &&
              // TODO: We don't support audio for start/stop layers
              !start &&
              stop == null,
          ) as LayerWithAudio[];

          if (audioLayers.length === 0) return createSilence();

          const processedAudioLayersRaw = await pMap(
            audioLayers,
            async (audioLayer, j) => {
              const { path, cutFrom, cutTo, speedFactor } = audioLayer;

              const streams = await readFileStreams(path);
              if (!streams.some((s) => s.codec_type === "audio")) return undefined;

              const layerAudioPath = join(tmpDir, `clip${i}-layer${j}-audio.flac`);

              try {
                let atempoFilter;
                if (Math.abs(speedFactor - 1) > 0.01) {
                  if (verbose) console.log("audio speedFactor", speedFactor);
                  const atempo = 1 / speedFactor;
                  if (!(atempo >= 0.5 && atempo <= 100)) {
                    // Required range by ffmpeg
                    console.warn(
                      `Audio speed ${atempo} is outside accepted range, using silence (clip ${i})`,
                    );
                    return undefined;
                  }
                  atempoFilter = `atempo=${atempo}`;
                }

                const cutToArg = (cutTo! - cutFrom!) * speedFactor;

                // Unify sample rate and channel layout before any later mixing,
                // so layers extracted from sources with differing formats share a clock.
                const formatFilters = [
                  ...(atempoFilter ? [atempoFilter] : []),
                  `aresample=${MIX_SAMPLE_RATE}`,
                  "aformat=channel_layouts=stereo",
                ];

                const args = [
                  "-nostdin",
                  ...getCutFromArgs({ cutFrom }),
                  "-i",
                  path,
                  "-t",
                  cutToArg!.toString(),
                  "-sample_fmt",
                  "s32",
                  "-ar",
                  MIX_SAMPLE_RATE.toString(),
                  "-ac",
                  "2",
                  "-map",
                  "a:0",
                  "-c:a",
                  "flac",
                  "-filter:a",
                  formatFilters.join(","),
                  "-y",
                  layerAudioPath,
                ];

                await ffmpeg(args);

                return [layerAudioPath, audioLayer];
              } catch (err) {
                if (verbose) console.error("Cannot extract audio from video", path, err);
                // Fall back to silence
                return undefined;
              }
            },
            { concurrency: 4 },
          );

          const processedAudioLayers = processedAudioLayersRaw.filter(
            (r): r is [string, LayerWithAudio] => r !== undefined,
          );

          if (processedAudioLayers.length < 1) return createSilence();

          if (processedAudioLayers.length === 1)
            return { clipAudioPath: processedAudioLayers[0][0], silent: false };

          // Merge/mix all layers' audio.
          // All layer audio was decoded to a common sample rate (MIX_SAMPLE_RATE) above,
          // so inputs with differing source sample rates are unified before mixing.
          // normalize=0 keeps the weighted sum at its true level instead of dividing
          // by the number of inputs (which would make the volume depend on track count).
          const weights = processedAudioLayers.map(([, { mixVolume }]) => parseVolume(mixVolume));
          const args = [
            "-nostdin",
            ...flatMap(processedAudioLayers, ([layerAudioPath]) => ["-i", layerAudioPath]),
            "-filter_complex",
            `amix=inputs=${processedAudioLayers.length}:duration=longest:normalize=${AMIX_NORMALIZE}:weights=${weights.join(" ")}`,
            "-ar",
            MIX_SAMPLE_RATE.toString(),
            "-ac",
            "2",
            "-c:a",
            "flac",
            "-y",
            clipAudioPath,
          ];

          await ffmpeg(args);
          return { clipAudioPath, silent: false };
        }

        const { clipAudioPath, silent } = await runInner();

        return {
          path: resolve(clipAudioPath), // https://superuser.com/a/853262/658247
          transition,
          silent,
        };
      },
      { concurrency: 4 },
    );
  }

  async function crossFadeConcatClipAudio(
    clipAudio: { path: string; transition?: TransitionOptions | null }[],
  ) {
    if (clipAudio.length < 2) {
      return clipAudio[0].path;
    }

    const outPath = join(tmpDir, "audio-concat.flac");

    if (verbose)
      console.log(
        "Combining audio",
        clipAudio.map(({ path }) => basename(path)),
      );

    // Build the filter graph as a chain. Each join is either:
    // - a hard `concat` when there is no transition (duration 0), so no audio is
    //   overlapped/faded and the boundary lands exactly where config says it does, or
    // - an `acrossfade` overlapping the end of the previous result with the next clip
    //   for exactly transition.duration, using equal-power (qsin) gain ramps by default.
    //
    // Every intermediate result gets an explicit named label ([ac0], [ac1], ...).
    // Relying on ffmpeg's positional stream labels (as the previous implementation did)
    // does not work once other filters (e.g. concat) are part of the graph.
    const filterParts: string[] = [];
    // Bare label name; the initial input is addressed by its ffmpeg stream specifier.
    let prevLabel = "0:a";
    const joinCount = clipAudio.length - 1;

    // The transition at the boundary between clip i and clip i+1 is configured
    // on the outgoing clip i (matching how parseConfig assigns it).
    clipAudio.slice(0, -1).forEach(({ transition }, i) => {
      const inputIndex = i + 1;
      // The last filter's output is the graph output: leave it unlabeled so
      // ffmpeg connects it to the output file automatically.
      const nextLabel = i < joinCount - 1 ? `ac${i}` : "";
      const duration = transition?.duration ?? 0;
      const outputLabel = nextLabel ? `[${nextLabel}]` : "";

      if (!(duration > 0)) {
        // Hard cut: splice the two streams without fading or losing any samples.
        filterParts.push(`[${prevLabel}][${inputIndex}:a]concat=n=2:v=0:a=1${outputLabel}`);
      } else {
        const outCurve = transition?.audioOutCurve || DEFAULT_AUDIO_OUT_CURVE;
        const inCurve = transition?.audioInCurve || DEFAULT_AUDIO_IN_CURVE;
        filterParts.push(
          `[${prevLabel}][${inputIndex}:a]acrossfade=d=${duration}:c1=${outCurve}:c2=${inCurve}${outputLabel}`,
        );
      }

      if (nextLabel) prevLabel = nextLabel;
    });

    const filterGraph = filterParts.join(";");

    const args = [
      "-nostdin",
      ...flatMap(clipAudio, ({ path }) => ["-i", path]),
      "-filter_complex",
      filterGraph,
      "-ar",
      MIX_SAMPLE_RATE.toString(),
      "-ac",
      "2",
      "-c",
      "flac",
      "-y",
      outPath,
    ];
    await ffmpeg(args);

    return outPath;
  }

  // FIXME[ts]: parseConfig sets `loop` on arbitrary audio tracks. Should that be part of the `AudioTrack` interface?
  async function mixArbitraryAudio({
    streams,
    audioNorm,
    outputVolume,
  }: {
    streams: (AudioTrack & { loop?: number })[];
    audioNorm?: AudioNormalizationOptions;
    outputVolume?: number | string;
  }) {
    let maxGain = 30;
    let gaussSize = 5;
    if (audioNorm) {
      if (audioNorm.gaussSize != null) gaussSize = audioNorm.gaussSize;
      if (audioNorm.maxGain != null) maxGain = audioNorm.maxGain;
    }
    const enableAudioNorm = audioNorm && audioNorm.enable;

    // First unify every input onto the same sample rate/channel layout
    // (a trim/delay/pad chain does not resample), so tracks recorded at different
    // sample rates are clock-aligned before they are summed.
    // https://stackoverflow.com/questions/35509147/ffmpeg-amix-filter-volume-issue-with-inputs-of-different-duration
    let filterComplex = streams
      .map(({ start, cutFrom, cutTo }, i) => {
        const cutToArg = cutTo != null ? `:end=${cutTo}` : "";
        const apadArg = i > 0 ? ",apad" : ""; // Don't pad the first track (audio from video clips with correct duration)

        return `[${i}:a]aresample=${MIX_SAMPLE_RATE},aformat=channel_layouts=stereo,atrim=start=${cutFrom || 0}${cutToArg},adelay=delays=${Math.floor((start || 0) * 1000)}:all=1${apadArg}[a${i}]`;
      })
      .join(";");

    const volumeArg = outputVolume != null ? `,volume=${outputVolume}` : "";
    const audioNormArg = enableAudioNorm ? `,dynaudnorm=g=${gaussSize}:maxgain=${maxGain}` : "";
    // normalize=0: plain weighted sum so the configured mixVolume values define the
    // envelope instead of ffmpeg re-scaling everything by the active input count.
    filterComplex += `;${streams.map((_, i) => `[a${i}]`).join("")}amix=inputs=${streams.length}:duration=first:dropout_transition=0:normalize=${AMIX_NORMALIZE}:weights=${streams.map((s) => parseVolume(s.mixVolume)).join(" ")}${audioNormArg}${volumeArg}`;

    const mixedAudioPath = join(tmpDir, "audio-mixed.flac");

    const args = [
      "-nostdin",
      ...flatMap(streams, ({ path, loop }) => ["-stream_loop", (loop || 0).toString(), "-i", path]),
      "-vn",
      "-filter_complex",
      filterComplex,
      "-ar",
      MIX_SAMPLE_RATE.toString(),
      "-ac",
      "2",
      "-c:a",
      "flac",
      "-y",
      mixedAudioPath,
    ];

    await ffmpeg(args);

    return mixedAudioPath;
  }

  async function editAudio({
    keepSourceAudio,
    clips,
    arbitraryAudio,
    clipsAudioVolume,
    audioNorm,
    outputVolume,
  }: EditAudioOptions) {
    // We need clips to process audio, because we need to know duration
    if (clips.length === 0) return undefined;

    // No need to process audio if none of these are satisfied
    if (!(keepSourceAudio || arbitraryAudio.length > 0)) return undefined;

    console.log("Extracting audio/silence from all clips");

    // Mix audio from each clip as separate files (or silent audio of appropriate length for clips with no audio)
    const clipAudio = await createMixedAudioClips({ clips, keepSourceAudio });

    // Return no audio if only silent clips and no arbitrary audio
    if (clipAudio.every((ca) => ca.silent) && arbitraryAudio.length === 0) return undefined;

    // Merge & fade the clip audio files
    const concatedClipAudioPath = await crossFadeConcatClipAudio(clipAudio);

    const streams: AudioTrack[] = [
      // The first stream is required, as it determines the length of the output audio.
      // All other streams will be truncated to its length
      { path: concatedClipAudioPath, mixVolume: clipsAudioVolume },

      ...arbitraryAudio,
    ];

    console.log("Mixing clip audio with arbitrary audio");

    if (streams.length < 2) return concatedClipAudioPath;

    const mixedFile = await mixArbitraryAudio({ streams, audioNorm, outputVolume });
    return mixedFile;
  }

  return {
    editAudio,
  };
};
