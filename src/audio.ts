import pMap from "p-map";
import { basename, join, resolve } from "path";
import type { Configuration } from "./configuration.js";
import { ffmpeg, readFileStreams } from "./ffmpeg.js";
import {
  buildAmixArgs,
  buildCrossFadeConcatArgs,
  buildExtractAudioArgs,
  buildMixArbitraryAudioArgs,
  buildSilenceAudioArgs,
  calcAtempo,
  isAtempoInRange,
} from "./ffmpegCommandBuilder.js";
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
            const args = buildSilenceAudioArgs({ duration: duration!, outPath: clipAudioPath });
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
                const atempo = calcAtempo(speedFactor);
                let atempoFilter;
                if (atempo !== undefined) {
                  if (verbose) console.log("audio speedFactor", speedFactor);
                  if (!isAtempoInRange(atempo)) {
                    // Required range by ffmpeg
                    console.warn(
                      `Audio speed ${atempo} is outside accepted range, using silence (clip ${i})`,
                    );
                    return undefined;
                  }
                  atempoFilter = `atempo=${atempo}`;
                }

                const args = buildExtractAudioArgs({
                  path,
                  cutFrom: cutFrom!,
                  cutTo: cutTo!,
                  speedFactor,
                  atempoFilter,
                  outPath: layerAudioPath,
                });

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

          // Merge/mix all layers' audio
          const weights = processedAudioLayers.map(([, { mixVolume }]) => mixVolume ?? 1);
          const args = buildAmixArgs({
            inputPaths: processedAudioLayers.map(([layerAudioPath]) => layerAudioPath),
            weights,
            outPath: clipAudioPath,
          });

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

    const args = buildCrossFadeConcatArgs({ clipAudio, outPath });
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
    const mixedAudioPath = join(tmpDir, "audio-mixed.flac");

    const args = buildMixArbitraryAudioArgs({
      streams,
      audioNorm,
      outputVolume,
      outPath: mixedAudioPath,
    });

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
