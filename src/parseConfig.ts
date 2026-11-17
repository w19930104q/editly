import assert from "assert";
import { registerFont } from "canvas";
import flatMap from "lodash-es/flatMap.js";
import pMap from "p-map";
import { basename } from "path";
import { Configuration } from "./configuration.js";
import { readDuration, readVideoFileInfo } from "./ffmpeg.js";
import { Transition } from "./transition.js";
import type {
  AudioTrack,
  CanvasLayer,
  FabricLayer,
  ImageLayer,
  ImageOverlayLayer,
  Layer,
  NewsTitleLayer,
  SlideInTextLayer,
  SubtitleLayer,
  TitleLayer,
  VideoLayer,
} from "./types.js";
import { assertFileValid } from "./util.js";

export type ProcessedClip = {
  layers: Layer[];
  duration: number;
  transition: Transition;
};

/**
 * A "detached-audio" layer, collected with the index of the clip it belongs to.
 * Its `start` is relative to the clip's start; the caller is responsible for
 * placing it on the final (frame-exact) timeline once the fps is known.
 */
export type DetachedAudio = {
  clipIndex: number;
  track: AudioTrack;
};

// Cache
const loadedFonts: string[] = [];

async function validateArbitraryAudio(
  audio: AudioTrack[] | undefined,
  allowRemoteRequests?: boolean,
) {
  assert(audio === undefined || Array.isArray(audio));

  if (audio) {
    for (const { path, cutFrom, cutTo, start } of audio) {
      await assertFileValid(path, allowRemoteRequests);

      if (cutFrom != null && cutTo != null) assert(cutTo > cutFrom);
      if (cutFrom != null) assert(cutFrom >= 0);
      if (cutTo != null) assert(cutTo >= 0);
      assert(start == null || start >= 0, `Invalid "start" ${start}`);
    }
  }
}

type ParseConfigOptions = {
  backgroundAudioPath?: string;
  arbitraryAudio: AudioTrack[];
} & Pick<
  Configuration,
  "clips" | "backgroundAudioVolume" | "loopAudio" | "allowRemoteRequests" | "defaults"
>;

export default async function parseConfig({
  clips,
  arbitraryAudio: arbitraryAudioIn,
  backgroundAudioPath,
  backgroundAudioVolume,
  loopAudio,
  allowRemoteRequests,
  defaults,
}: ParseConfigOptions) {
  async function handleLayer(layer: Layer): Promise<Layer | Layer[]> {
    // https://github.com/mifi/editly/issues/39
    if (layer.type === "image" || layer.type === "image-overlay") {
      await assertFileValid((layer as ImageOverlayLayer | ImageLayer).path, allowRemoteRequests);
    } else if (layer.type === "gl") {
      await assertFileValid(layer.fragmentPath, allowRemoteRequests);
    }

    if (["fabric", "canvas"].includes(layer.type)) {
      assert(
        typeof (layer as FabricLayer | CanvasLayer).func === "function",
        '"func" must be a function',
      );
    }

    if (
      [
        "image",
        "image-overlay",
        "fabric",
        "canvas",
        "gl",
        "radial-gradient",
        "linear-gradient",
        "fill-color",
      ].includes(layer.type)
    ) {
      return layer;
    }

    if (["title", "subtitle", "news-title", "slide-in-text"].includes(layer.type)) {
      const { fontPath, ...rest } = layer as
        | TitleLayer
        | SubtitleLayer
        | NewsTitleLayer
        | SlideInTextLayer;
      assert(rest.text, "Please specify a text");

      let { fontFamily } = rest;
      if (fontPath) {
        fontFamily = Buffer.from(basename(fontPath)).toString("base64");
        if (!loadedFonts.includes(fontFamily)) {
          registerFont(fontPath, { family: fontFamily, weight: "regular", style: "normal" });
          loadedFonts.push(fontFamily);
        }
      }
      return { ...rest, fontFamily };
    }

    throw new Error(`Invalid layer type ${layer.type}`);
  }

  const detachedAudioByClip: Record<number, AudioTrack[]> = {};

  const clipsOut: ProcessedClip[] = await pMap(
    clips,
    async (clip, clipIndex) => {
      const { layers } = clip;
      const transition = new Transition(clip.transition, clipIndex === clips.length - 1);

      let layersOut = flatMap(
        await pMap(
          layers,
          async <T extends Layer>(layer: T) => {
            if (layer.type === "video") {
              const {
                duration: fileDuration,
                width: widthIn,
                height: heightIn,
                framerateStr,
                rotation,
              } = await readVideoFileInfo(layer.path);
              let { cutFrom, cutTo } = layer;
              if (!cutFrom) cutFrom = 0;
              cutFrom = Math.max(cutFrom, 0);
              cutFrom = Math.min(cutFrom, fileDuration);

              if (!cutTo) cutTo = fileDuration;
              cutTo = Math.max(cutTo, cutFrom);
              cutTo = Math.min(cutTo, fileDuration);
              assert(cutFrom < cutTo, "cutFrom must be lower than cutTo");

              const layerDuration = cutTo - cutFrom;

              const isRotated = rotation && [-90, 90, 270, -270].includes(rotation);
              const inputWidth = isRotated ? heightIn : widthIn;
              const inputHeight = isRotated ? widthIn : heightIn;

              return {
                ...layer,
                cutFrom,
                cutTo,
                layerDuration,
                framerateStr,
                inputWidth,
                inputHeight,
              } as T;
            }

            // Audio is handled later
            if (["audio", "detached-audio"].includes(layer.type)) return layer;

            return handleLayer(layer);
          },
          { concurrency: 1 },
        ),
      );

      let clipDuration = clip.duration;

      if (!clipDuration) {
        const video = layersOut.find((layer): layer is VideoLayer => layer.type === "video");
        clipDuration = video?.layerDuration ?? defaults.duration;
      }

      assert(clipDuration, `Duration parameter is required for videoless clip ${clipIndex}`);

      // We need to map again, because for audio, we need to know the correct clipDuration
      layersOut = (
        await pMap(layersOut, async <T extends Layer>(layerIn: T) => {
          if (!layerIn.start) layerIn.start = 0;

          // This feature allows the user to show another layer overlayed (or replacing) parts of the lower layers (start - stop)
          const layerDuration = (layerIn.stop || clipDuration) - layerIn.start;
          assert(
            layerDuration > 0 && layerDuration <= clipDuration,
            `Invalid start ${layerIn.start} or stop ${layerIn.stop} (${clipDuration})`,
          );
          // TODO Also need to handle video layers (speedFactor etc)
          // TODO handle audio in case of start/stop

          const layer: T = { ...layerIn, layerDuration };

          if (layer.type === "audio") {
            const fileDuration = await readDuration(layer.path);
            let { cutFrom, cutTo } = layer;

            // console.log({ cutFrom, cutTo, fileDuration, clipDuration });

            if (!cutFrom) cutFrom = 0;
            cutFrom = Math.max(cutFrom, 0);
            cutFrom = Math.min(cutFrom, fileDuration);

            if (!cutTo) cutTo = cutFrom + clipDuration;
            cutTo = Math.max(cutTo, cutFrom);
            cutTo = Math.min(cutTo, fileDuration);
            assert(cutFrom < cutTo, "cutFrom must be lower than cutTo");

            const layerDuration = cutTo - cutFrom;

            const speedFactor = clipDuration / layerDuration;

            return { ...layer, cutFrom, cutTo, speedFactor };
          }

          if (layer.type === "video") {
            let speedFactor;

            // If user explicitly specified duration for clip, it means that should be the output duration of the video
            if (clipDuration) {
              // Later we will speed up or slow down video using this factor
              speedFactor = clipDuration / layerDuration;
            } else {
              speedFactor = 1;
            }

            return { ...layer, speedFactor };
          }

          // These audio tracks are detached from the clips (can run over multiple clips)
          // This is useful so we can have audio start relative to their parent clip's start time
          if (layer.type === "detached-audio") {
            if (!detachedAudioByClip[clipIndex]) detachedAudioByClip[clipIndex] = [];
            detachedAudioByClip[clipIndex].push(layer);
            return undefined; // Will be filtered out
          }

          return layer;
        })
      ).filter((l) => l !== undefined);

      // Filter out deleted layers
      layersOut = layersOut.filter((l) => l);

      return {
        transition,
        duration: clipDuration,
        layers: layersOut,
      };
    },
    { concurrency: 1 },
  );

  // Detached audio tracks run relative to their parent clip's start time. The actual
  // offset on the output timeline can only be computed once the fps is known and the
  // transitions have been quantized to whole frames, so we just collect them here and
  // let the caller place them on the final timeline (see `computeTimeline`).
  const detachedAudio: DetachedAudio[] = [];
  clipsOut.forEach((_, clipIndex) => {
    for (const track of detachedAudioByClip[clipIndex] || []) {
      detachedAudio.push({ clipIndex, track });
    }
  });

  // Audio can either come from `audioFilePath`, `audio` or from "detached" audio layers from clips
  const arbitraryAudio = [
    // Background audio is treated just like arbitrary audio
    ...(backgroundAudioPath
      ? [
          {
            path: backgroundAudioPath,
            mixVolume: backgroundAudioVolume != null ? backgroundAudioVolume : 1,
            loop: loopAudio ? -1 : 0,
          },
        ]
      : []),
    ...arbitraryAudioIn,
  ];

  await validateArbitraryAudio(
    [...arbitraryAudio, ...detachedAudio.map(({ track }) => track)],
    allowRemoteRequests,
  );

  return {
    clips: clipsOut,
    arbitraryAudio,
    detachedAudio,
  };
}
