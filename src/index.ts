import assert from "assert";
import { Options, ResultPromise } from "execa";
import fsExtra from "fs-extra";
import JSON5 from "json5";

import Audio from "./audio.js";
import { Configuration, type ConfigurationOptions } from "./configuration.js";
import { configureFf, ffmpeg, parseFps } from "./ffmpeg.js";
import { createFrameSource } from "./frameSource.js";
import parseConfig, { ProcessedClip } from "./parseConfig.js";
import { createFabricCanvas, rgbaToFabricImage } from "./sources/fabric.js";
import { computeTimeline, generateFrameSchedule, getSafeTransitionDuration } from "./timeline.js";
import type { RenderSingleFrameConfig } from "./types.js";
import { assertFileValid, multipleOf2 } from "./util.js";

const channels = 4;

export type * from "./transition.js";
export type * from "./types.js";

/**
 * Edit and render videos.
 *
 * @param config - ConfigurationOptions.
 */
async function Editly(input: ConfigurationOptions): Promise<void> {
  const config = new Configuration(input);
  const {
    // Testing options:
    verbose = false,
    logTimes = false,
    keepTmp = false,
    fast = false,

    outPath,
    clips: clipsIn,
    clipsAudioVolume,
    audioTracks: arbitraryAudioIn,
    width: requestedWidth,
    height: requestedHeight,
    fps: requestedFps,
    audioFilePath: backgroundAudioPath,
    backgroundAudioVolume,
    loopAudio,
    keepSourceAudio,
    allowRemoteRequests,
    audioNorm,
    outputVolume,
    customOutputArgs,
    isGif,
    tmpDir,
    defaults,
  } = config;

  await configureFf(config);

  if (backgroundAudioPath) await assertFileValid(backgroundAudioPath, allowRemoteRequests);

  if (verbose) console.log(JSON5.stringify(config, null, 2));

  const { clips, arbitraryAudio: arbitraryAudioBase, detachedAudio } = await parseConfig({
    clips: clipsIn,
    arbitraryAudio: arbitraryAudioIn,
    backgroundAudioPath,
    backgroundAudioVolume,
    loopAudio,
    allowRemoteRequests,
    defaults,
  });

  if (verbose) console.log({ tmpDir });
  await fsExtra.mkdirp(tmpDir);

  // Try to detect parameters from first video
  let firstVideoWidth;
  let firstVideoHeight;
  let firstVideoFramerateStr;

  clips.find(
    (clip) =>
      clip &&
      clip.layers.find((layer) => {
        if (layer.type === "video") {
          firstVideoWidth = layer.inputWidth;
          firstVideoHeight = layer.inputHeight;
          firstVideoFramerateStr = layer.framerateStr;

          return true;
        }
        return false;
      }),
  );

  let width: number;
  let height: number;

  let desiredWidth;

  if (requestedWidth) desiredWidth = requestedWidth;
  else if (isGif) desiredWidth = 320;

  const roundDimension = (val: number) => (isGif ? Math.round(val) : multipleOf2(val));

  if (firstVideoWidth && firstVideoHeight) {
    if (desiredWidth) {
      const calculatedHeight = (firstVideoHeight / firstVideoWidth) * desiredWidth;
      height = roundDimension(calculatedHeight);
      width = desiredWidth;
    } else {
      width = firstVideoWidth;
      height = firstVideoHeight;
    }
  } else if (desiredWidth) {
    width = desiredWidth;
    height = desiredWidth;
    // console.log(`Cannot detect width/height from video, set defaults ${width}x${height}`);
  } else {
    // No video
    width = 640;
    height = 640;
  }

  // User override?
  if (requestedWidth && requestedHeight) {
    width = requestedWidth;
    height = requestedHeight;
  }

  if (fast) {
    const numPixelsEachDirection = 250;
    const aspectRatio = width / height;
    width = roundDimension(numPixelsEachDirection * Math.sqrt(aspectRatio));
    height = roundDimension(numPixelsEachDirection * Math.sqrt(1 / aspectRatio));
  }

  assert(width, "Width not specified or detected");
  assert(height, "Height not specified or detected");

  if (!isGif) {
    // x264 requires multiple of 2, eg minimum 2
    width = Math.max(2, width);
    height = Math.max(2, height);
  }

  let fps: number;
  let framerateStr: string;

  if (fast) {
    fps = 15;
    framerateStr = String(fps);
  } else if (requestedFps && typeof requestedFps === "number") {
    fps = requestedFps;
    framerateStr = String(requestedFps);
  } else if (isGif) {
    fps = 10;
    framerateStr = String(fps);
  } else if (firstVideoFramerateStr) {
    fps = parseFps(firstVideoFramerateStr) ?? 25;
    framerateStr = firstVideoFramerateStr;
  } else {
    fps = 25;
    framerateStr = String(fps);
  }

  assert(fps, "FPS not specified or detected");

  console.log(`${width}x${height} ${fps}fps`);

  // Compute the frame-exact timeline. All transition clamping/rounding happens here,
  // in the frame domain, so that video frames, audio crossfades and detached audio
  // offsets all agree exactly.
  const timeline = computeTimeline(
    clips.map((clip) => ({
      duration: clip.duration,
      transitionDuration: clip.transition.duration,
    })),
    fps,
  );

  // Quantize transition durations to whole frames, so that the audio crossfades
  // (which are specified in seconds) match the video transitions exactly.
  clips.forEach((clip, i) => {
    clip.transition.duration = timeline.clips[i].transitionNumFrames / fps;
  });

  // Now that the timeline is final, we know exactly where each clip starts on the
  // output timeline, so we can place the detached audio tracks.
  const arbitraryAudio = [
    ...arbitraryAudioBase,
    ...detachedAudio.map(({ clipIndex, track }) => ({
      ...track,
      start: timeline.clips[clipIndex].startFrame / fps + (track.start ?? 0),
    })),
  ];

  if (verbose) console.log("Calculated", JSON5.stringify({ clips, arbitraryAudio }, null, 2));

  const { editAudio } = Audio({ verbose, tmpDir });

  const audioFilePath = !isGif
    ? await editAudio({
        keepSourceAudio,
        arbitraryAudio,
        clipsAudioVolume,
        clips,
        audioNorm,
        outputVolume,
      })
    : undefined;

  const estimatedTotalFrames = timeline.totalFrames;

  function getOutputArgs() {
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

    const audioOutputArgs = audioFilePath ? ["-acodec", "aac", "-b:a", "128k"] : [];

    return [...audioOutputArgs, ...videoOutputArgs];
  }

  function startFfmpegWriterProcess() {
    const args = [
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

      ...getOutputArgs(),

      "-y",
      outPath,
    ];
    return ffmpeg(args, {
      encoding: "buffer",
      buffer: false,
      stdin: "pipe",
      stdout: process.stdout,
      stderr: process.stderr,
    });
  }

  let outProcess: ResultPromise<Options> | undefined;
  let outProcessExitCode;

  type ClipFrameSource = Awaited<ReturnType<typeof createFrameSource>>;

  let frameSource1: ClipFrameSource | undefined;
  let frameSource2: ClipFrameSource | undefined;

  let frameSource1Data: Buffer | undefined;

  let totalFramesWritten = 0;

  // Index of the clip that frameSource1 is currently reading
  let currentClipIndex = 0;

  const getSource = async (clip: ProcessedClip, clipIndex: number) =>
    createFrameSource({
      clip,
      clipIndex,
      width,
      height,
      channels,
      verbose,
      logTimes,
      framerateStr,
    });

  try {
    try {
      outProcess = startFfmpegWriterProcess();

      let outProcessError;

      outProcess.on("exit", (code) => {
        if (verbose) console.log("Output ffmpeg exited", code);
        outProcessExitCode = code;
      });

      // If we write and get an EPIPE (like when ffmpeg fails or is finished), we could get an unhandled rejection if we don't catch the promise
      // (and meow causes the CLI to exit on unhandled rejections making it hard to see)
      outProcess.catch((err) => {
        outProcessError = err;
      });

      frameSource1 = await getSource(clips[0], 0);
      frameSource2 = clips[1] ? await getSource(clips[1], 1) : undefined;

      let runTransitionOnFrame: ReturnType<ProcessedClip["transition"]["create"]> | undefined;

      // The frame schedule tells us exactly which clip frame(s) each output frame
      // consists of, so the rendered timeline matches the configuration exactly.
      for (const frame of generateFrameSchedule(timeline.clips)) {
        if (outProcessError) break;

        // Moved on to the next clip? (Can advance by more than one if a clip
        // renders zero frames)
        while (frame.fromClipIndex !== currentClipIndex) {
          currentClipIndex += 1;
          console.log(
            `Done with transition, switching to next transitionFromClip (${currentClipIndex})`,
          );

          // Cleanup completed frameSource1, swap and load next frameSource2
          await frameSource1!.close();
          frameSource1 = frameSource2;
          const nextClip = clips[currentClipIndex + 1];
          frameSource2 = nextClip ? await getSource(nextClip, currentClipIndex + 1) : undefined;

          runTransitionOnFrame = undefined;
        }

        const currentTransition = clips[currentClipIndex].transition;

        if (!verbose) {
          const percentDone = Math.floor(100 * (totalFramesWritten / estimatedTotalFrames));
          if (totalFramesWritten % 10 === 0)
            process.stdout.write(`${String(percentDone).padStart(3, " ")}% `);
        }

        // Frame-local time is derived from the frame index, so layer start/stop
        // boundaries land exactly on the configured frames.
        const fromClipTime = frame.fromClipFrame / fps;

        if (logTimes) console.time("Read frameSource1");
        const newFrameSource1Data = await frameSource1!.readNextFrame({ time: fromClipTime });
        if (logTimes) console.timeEnd("Read frameSource1");
        // If we got no data, use the old data
        // TODO maybe abort?
        if (newFrameSource1Data) frameSource1Data = newFrameSource1Data;
        else console.warn("No frame data returned, using last frame");

        const isInTransition = frame.toClipIndex != null && frameSource2 != null;

        let outFrameData;

        if (isInTransition && frameSource2) {
          const toClipTime = frame.toClipFrame! / fps;

          if (logTimes) console.time("Read frameSource2");
          const frameSource2Data = await frameSource2.readNextFrame({ time: toClipTime });
          if (logTimes) console.timeEnd("Read frameSource2");

          if (frameSource2Data) {
            const progress = frame.toClipFrame! / frame.transitionNumFrames;

            if (!runTransitionOnFrame)
              runTransitionOnFrame = currentTransition.create({ width, height, channels });

            if (logTimes) console.time("runTransitionOnFrame");

            outFrameData = runTransitionOnFrame({
              fromFrame: frameSource1Data!,
              toFrame: frameSource2Data,
              progress: progress,
            });

            if (logTimes) console.timeEnd("runTransitionOnFrame");
          } else {
            console.warn("Got no frame data from transitionToClip!");
            // We have probably reached end of clip2 but transition is not complete. Just pass thru clip1
            outFrameData = frameSource1Data;
          }
        } else {
          // Not in transition. Pass thru clip 1
          outFrameData = frameSource1Data;
        }

        if (verbose) {
          if (isInTransition)
            console.log(
              "Writing frame:",
              totalFramesWritten,
              "from clip",
              currentClipIndex,
              `(frame ${frame.fromClipFrame})`,
              "to clip",
              frame.toClipIndex,
              `(frame ${frame.toClipFrame} / ${frame.transitionNumFrames})`,
              currentTransition.name,
              `${currentTransition.duration}s`,
            );
          else
            console.log(
              "Writing frame:",
              totalFramesWritten,
              "from clip",
              currentClipIndex,
              `(frame ${frame.fromClipFrame})`,
            );
          // console.log(outFrameData.length / 1e6, 'MB');
        }

        const nullOutput = false;

        if (logTimes) console.time("outProcess.write");

        // If we don't wait, then we get EINVAL when dealing with high resolution files (big writes)
        if (!nullOutput) await new Promise((r) => outProcess?.stdin?.write(outFrameData, r));

        if (logTimes) console.timeEnd("outProcess.write");

        if (outProcessError) break;

        totalFramesWritten += 1;
      } // End frame schedule loop

      console.log("No more frames, done");

      outProcess.stdin?.end();
    } catch (err) {
      outProcess?.kill();
      throw err;
    } finally {
      if (verbose) console.log("Cleanup");
      if (frameSource1) await frameSource1.close();
      if (frameSource2) await frameSource2.close();
    }

    try {
      if (verbose) console.log("Waiting for output ffmpeg process to finish");
      await outProcess;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (outProcessExitCode !== 0 && !(err as any).isTerminated) throw err;
    }
  } finally {
    if (!keepTmp) await fsExtra.remove(tmpDir);
  }

  console.log();
  console.log("Done. Output file can be found at:");
  console.log(outPath);
}

/**
 * Pure function to get a frame at a certain time.
 *
 * @param config - ConfigurationOptions.
 */
export async function renderSingleFrame(input: RenderSingleFrameConfig): Promise<void> {
  const time = input.time ?? 0;

  const config = new Configuration(input);
  const {
    clips: clipsIn,
    allowRemoteRequests,
    width = 800,
    height = 600,
    verbose,
    logTimes,
    outPath = `${Math.floor(Math.random() * 1e12)}.png`,
    defaults,
  } = config;

  configureFf(config);

  console.log({ clipsIn });

  const { clips } = await parseConfig({
    clips: clipsIn,
    arbitraryAudio: [],
    allowRemoteRequests,
    defaults,
  });
  let clipStartTime = 0;
  const clip = clips.find((c, i) => {
    if (clipStartTime <= time && time < clipStartTime + c.duration) return true;
    // The transition overlaps the end of this clip with the start of the next one,
    // so the next clip starts earlier by the transition duration.
    clipStartTime +=
      c.duration -
      getSafeTransitionDuration({
        transitionDuration: c.transition.duration,
        clipDuration: c.duration,
        nextClipDuration: clips[i + 1]?.duration,
      });
    return false;
  });
  assert(clip, "No clip found at requested time");
  const clipIndex = clips.indexOf(clip);
  const frameSource = await createFrameSource({
    clip,
    clipIndex,
    width,
    height,
    channels,
    verbose,
    logTimes,
    framerateStr: "1",
  });
  const rgba = await frameSource.readNextFrame({ time: time - clipStartTime });

  // TODO converting rgba to png can be done more easily?
  const canvas = createFabricCanvas({ width, height });
  const fabricImage = await rgbaToFabricImage({ width, height, rgba });
  canvas.add(fabricImage);
  canvas.renderAll();
  const internalCanvas = canvas.getNodeCanvas();
  await fsExtra.writeFile(outPath, internalCanvas.toBuffer("image/png"));
  canvas.clear();
  canvas.dispose();
  await frameSource.close();
}

Editly.renderSingleFrame = renderSingleFrame;

export default Editly;
