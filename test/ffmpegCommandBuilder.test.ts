import { describe, expect, test } from "vitest";
import {
  buildAmixArgs,
  buildCrossFadeConcatArgs,
  buildCrossFadeFilterGraph,
  buildExtractAudioArgs,
  buildMixArbitraryAudioArgs,
  buildMixArbitraryAudioFilterComplex,
  buildOutputArgs,
  buildPtsFilter,
  buildScaleFilter,
  buildSilenceAudioArgs,
  buildVideoFrameSourceArgs,
  buildWriterArgs,
  calcAtempo,
  getCutFromArgs,
  getCutToArgs,
  getFfmpegCommonArgs,
  getVideoInputCodec,
  isAtempoInRange,
} from "../src/ffmpegCommandBuilder.js";

describe("getFfmpegCommonArgs", () => {
  test("hides log by default", () => {
    expect(getFfmpegCommonArgs({ enableFfmpegLog: false })).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
    ]);
  });

  test("keeps log when enabled", () => {
    expect(getFfmpegCommonArgs({ enableFfmpegLog: true })).toEqual(["-hide_banner"]);
  });
});

describe("cut args", () => {
  test("getCutFromArgs", () => {
    expect(getCutFromArgs({ cutFrom: undefined })).toEqual([]);
    expect(getCutFromArgs({ cutFrom: 0 })).toEqual([]);
    expect(getCutFromArgs({ cutFrom: 0.5 })).toEqual(["-ss", "0.5"]);
  });

  test("getCutToArgs", () => {
    expect(getCutToArgs({ cutFrom: 1, cutTo: 3, speedFactor: 0.5 })).toEqual(["-t", 1]);
    expect(getCutToArgs({ cutFrom: undefined, cutTo: 3, speedFactor: 1 })).toEqual([]);
    expect(getCutToArgs({ cutFrom: 1, cutTo: undefined, speedFactor: 1 })).toEqual([]);
  });
});

describe("buildSilenceAudioArgs", () => {
  test("generates anullsrc silence command", () => {
    expect(buildSilenceAudioArgs({ duration: 2.5, outPath: "out.flac" })).toEqual([
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
      "2.5",
      "-c:a",
      "flac",
      "-y",
      "out.flac",
    ]);
  });
});

describe("atempo", () => {
  test("calcAtempo returns undefined when speed is (nearly) unchanged", () => {
    expect(calcAtempo(1)).toBeUndefined();
    expect(calcAtempo(1.005)).toBeUndefined();
    expect(calcAtempo(0.995)).toBeUndefined();
  });

  test("calcAtempo inverts the speed factor", () => {
    expect(calcAtempo(0.5)).toBe(2);
    expect(calcAtempo(2)).toBe(0.5);
    expect(calcAtempo(0.8)).toBeCloseTo(1.25, 10);
  });

  test("isAtempoInRange enforces ffmpeg's [0.5, 100] range", () => {
    expect(isAtempoInRange(0.5)).toBe(true);
    expect(isAtempoInRange(100)).toBe(true);
    expect(isAtempoInRange(0.49)).toBe(false);
    expect(isAtempoInRange(100.01)).toBe(false);
  });
});

describe("buildExtractAudioArgs", () => {
  test("without speed change", () => {
    expect(
      buildExtractAudioArgs({
        path: "v.mp4",
        cutFrom: 0.5,
        cutTo: 3,
        speedFactor: 1,
        outPath: "out.flac",
      }),
    ).toEqual([
      "-nostdin",
      "-ss",
      "0.5",
      "-i",
      "v.mp4",
      "-t",
      "2.5",
      "-sample_fmt",
      "s32",
      "-ar",
      "48000",
      "-map",
      "a:0",
      "-c:a",
      "flac",
      "-y",
      "out.flac",
    ]);
  });

  test("with atempo filter", () => {
    expect(
      buildExtractAudioArgs({
        path: "v.mp4",
        cutFrom: 1,
        cutTo: 3,
        speedFactor: 0.5,
        atempoFilter: "atempo=2",
        outPath: "out.flac",
      }),
    ).toEqual([
      "-nostdin",
      "-ss",
      "1",
      "-i",
      "v.mp4",
      "-t",
      "1",
      "-sample_fmt",
      "s32",
      "-ar",
      "48000",
      "-map",
      "a:0",
      "-c:a",
      "flac",
      "-filter:a",
      "atempo=2",
      "-y",
      "out.flac",
    ]);
  });
});

describe("buildAmixArgs", () => {
  test("mixes inputs with weights", () => {
    expect(
      buildAmixArgs({
        inputPaths: ["a.flac", "b.flac", "c.flac"],
        weights: [1, 0.5, 10],
        outPath: "out.flac",
      }),
    ).toEqual([
      "-nostdin",
      "-i",
      "a.flac",
      "-i",
      "b.flac",
      "-i",
      "c.flac",
      "-filter_complex",
      "amix=inputs=3:duration=longest:weights=1 0.5 10",
      "-c:a",
      "flac",
      "-y",
      "out.flac",
    ]);
  });
});

describe("buildCrossFadeFilterGraph", () => {
  test("single transition with custom audio curves", () => {
    expect(
      buildCrossFadeFilterGraph([
        { transition: { duration: 0.5, audioOutCurve: "qsin", audioInCurve: "hsin" } },
        { transition: null },
      ]),
    ).toBe("[0:a][1:a]acrossfade=d=0.5:c1=qsin:c2=hsin");
  });

  test("chains multiple transitions and defaults curves to tri", () => {
    expect(
      buildCrossFadeFilterGraph([
        { transition: { duration: 0.5 } },
        { transition: { duration: 0.4 } },
        { transition: null },
      ]),
    ).toBe(
      "[0:a][1:a]acrossfade=d=0.5:c1=tri:c2=tri[concat0],[concat0][2:a]acrossfade=d=0.4:c1=tri:c2=tri",
    );
  });

  test("uses epsilon for zero/missing transition duration", () => {
    expect(buildCrossFadeFilterGraph([{ transition: { duration: 0 } }, {}])).toBe(
      "[0:a][1:a]acrossfade=d=0.0001:c1=tri:c2=tri",
    );
    expect(buildCrossFadeFilterGraph([{}, {}])).toBe(
      "[0:a][1:a]acrossfade=d=0.0001:c1=tri:c2=tri",
    );
  });
});

describe("buildCrossFadeConcatArgs", () => {
  test("builds full concat command", () => {
    expect(
      buildCrossFadeConcatArgs({
        clipAudio: [
          { path: "clip0.flac", transition: { duration: 0.5 } },
          { path: "clip1.flac", transition: null },
        ],
        outPath: "audio-concat.flac",
      }),
    ).toEqual([
      "-nostdin",
      "-i",
      "clip0.flac",
      "-i",
      "clip1.flac",
      "-filter_complex",
      "[0:a][1:a]acrossfade=d=0.5:c1=tri:c2=tri",
      "-c",
      "flac",
      "-y",
      "audio-concat.flac",
    ]);
  });
});

describe("buildMixArbitraryAudioFilterComplex", () => {
  test("trims, delays, pads and mixes streams", () => {
    expect(
      buildMixArbitraryAudioFilterComplex({
        streams: [
          { path: "concat.flac", mixVolume: 0.8 },
          { path: "music.mp3", start: 1, cutFrom: 0.5, cutTo: 6, mixVolume: 5 },
        ],
      }),
    ).toBe(
      "[0:a]atrim=start=0,adelay=delays=0:all=1[a0];" +
        "[1:a]atrim=start=0.5:end=6,adelay=delays=1000:all=1,apad[a1];" +
        "[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:weights=0.8 5",
    );
  });

  test("adds dynaudnorm and volume when enabled", () => {
    expect(
      buildMixArbitraryAudioFilterComplex({
        streams: [{ path: "a.flac" }],
        audioNorm: { enable: true, gaussSize: 3, maxGain: 20 },
        outputVolume: 0.9,
      }),
    ).toBe(
      "[0:a]atrim=start=0,adelay=delays=0:all=1[a0];" +
        "[a0]amix=inputs=1:duration=first:dropout_transition=0:weights=1" +
        ",dynaudnorm=g=3:maxgain=20,volume=0.9",
    );
  });

  test("uses default gaussSize/maxGain and ignores disabled audioNorm", () => {
    expect(
      buildMixArbitraryAudioFilterComplex({
        streams: [{ path: "a.flac" }],
        audioNorm: { enable: true },
      }),
    ).toContain("dynaudnorm=g=5:maxgain=30");

    expect(
      buildMixArbitraryAudioFilterComplex({
        streams: [{ path: "a.flac" }],
        audioNorm: { enable: false },
      }),
    ).not.toContain("dynaudnorm");
  });
});

describe("buildMixArbitraryAudioArgs", () => {
  test("loops inputs and mixes", () => {
    expect(
      buildMixArbitraryAudioArgs({
        streams: [
          { path: "concat.flac", mixVolume: 0.8 },
          { path: "music.mp3", loop: -1, mixVolume: 5 },
        ],
        outPath: "audio-mixed.flac",
      }),
    ).toEqual([
      "-nostdin",
      "-stream_loop",
      "0",
      "-i",
      "concat.flac",
      "-stream_loop",
      "-1",
      "-i",
      "music.mp3",
      "-vn",
      "-filter_complex",
      "[0:a]atrim=start=0,adelay=delays=0:all=1[a0];" +
        "[1:a]atrim=start=0,adelay=delays=0:all=1,apad[a1];" +
        "[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:weights=0.8 5",
      "-c:a",
      "flac",
      "-y",
      "audio-mixed.flac",
    ]);
  });
});

describe("buildScaleFilter", () => {
  test("contain with wider input scales to requested width", () => {
    expect(
      buildScaleFilter({
        resizeMode: "contain",
        requestedWidth: 640,
        requestedHeight: 360,
        inputWidth: 1280,
        inputHeight: 720,
      }),
    ).toEqual({ scaleFilter: "scale=640:360", targetWidth: 640, targetHeight: 360 });
  });

  test("contain-blur with taller input scales to requested height", () => {
    expect(
      buildScaleFilter({
        resizeMode: "contain-blur",
        requestedWidth: 640,
        requestedHeight: 360,
        inputWidth: 640,
        inputHeight: 480,
      }),
    ).toEqual({ scaleFilter: "scale=480:360", targetWidth: 480, targetHeight: 360 });
  });

  test("cover scales up and crops to requested size", () => {
    expect(
      buildScaleFilter({
        resizeMode: "cover",
        requestedWidth: 640,
        requestedHeight: 360,
        inputWidth: 640,
        inputHeight: 480,
      }),
    ).toEqual({
      scaleFilter: "scale=640:480,crop=640:360",
      targetWidth: 640,
      targetHeight: 360,
    });
  });

  test("cover with wider input scales by height", () => {
    expect(
      buildScaleFilter({
        resizeMode: "cover",
        requestedWidth: 360,
        requestedHeight: 640,
        inputWidth: 1280,
        inputHeight: 720,
      }),
    ).toEqual({
      scaleFilter: "scale=1138:640,crop=360:640",
      targetWidth: 360,
      targetHeight: 640,
    });
  });

  test("stretch scales directly to requested size", () => {
    expect(
      buildScaleFilter({
        resizeMode: "stretch",
        requestedWidth: 640,
        requestedHeight: 360,
        inputWidth: 640,
        inputHeight: 480,
      }),
    ).toEqual({ scaleFilter: "scale=640:360", targetWidth: 640, targetHeight: 360 });
  });
});

describe("buildPtsFilter", () => {
  test("empty when speed unchanged", () => {
    expect(buildPtsFilter(1)).toBe("");
  });

  test("setpts when speed changed", () => {
    expect(buildPtsFilter(0.5)).toBe("setpts=0.5*PTS,");
  });
});

describe("getVideoInputCodec", () => {
  test("maps vp8/vp9 to libvpx decoders", () => {
    expect(getVideoInputCodec("vp8")).toBe("libvpx");
    expect(getVideoInputCodec("vp9")).toBe("libvpx-vp9");
  });

  test("other codecs need no explicit decoder", () => {
    expect(getVideoInputCodec("h264")).toBeUndefined();
    expect(getVideoInputCodec(undefined)).toBeUndefined();
  });
});

describe("buildVideoFrameSourceArgs", () => {
  test("full command with codec, cuts and speed change", () => {
    expect(
      buildVideoFrameSourceArgs({
        path: "v.webm",
        inputCodec: "libvpx",
        cutFrom: 1,
        cutTo: 3,
        speedFactor: 0.5,
        framerateStr: "25",
        scaleFilter: "scale=640:480,crop=640:360",
      }),
    ).toEqual([
      "-nostdin",
      "-vcodec",
      "libvpx",
      "-ss",
      "1",
      "-i",
      "v.webm",
      "-t",
      "1",
      "-vf",
      "setpts=0.5*PTS,fps=25,scale=640:480,crop=640:360",
      "-map",
      "v:0",
      "-vcodec",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-f",
      "image2pipe",
      "-",
    ]);
  });

  test("minimal command without codec, cuts or speed change", () => {
    expect(
      buildVideoFrameSourceArgs({
        path: "v.mp4",
        speedFactor: 1,
        framerateStr: "30",
        scaleFilter: "scale=640:360",
      }),
    ).toEqual([
      "-nostdin",
      "-i",
      "v.mp4",
      "-vf",
      "fps=30,scale=640:360",
      "-map",
      "v:0",
      "-vcodec",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-f",
      "image2pipe",
      "-",
    ]);
  });
});

describe("buildOutputArgs", () => {
  test("h264 output with audio", () => {
    expect(buildOutputArgs({ isGif: false, fps: 25, width: 640, height: 360, hasAudio: true })).toEqual(
      [
        "-acodec",
        "aac",
        "-b:a",
        "128k",
        "-vf",
        "format=yuv420p",
        "-vcodec",
        "libx264",
        "-profile:v",
        "high",
        "-preset:v",
        "medium",
        "-crf",
        "18",
        "-movflags",
        "faststart",
      ],
    );
  });

  test("fast mode uses ultrafast preset", () => {
    const args = buildOutputArgs({ isGif: false, fps: 25, width: 640, height: 360, fast: true, hasAudio: false });
    expect(args).toContain("ultrafast");
    expect(args).not.toContain("-acodec");
  });

  test("gif output uses palette filter", () => {
    expect(buildOutputArgs({ isGif: true, fps: 10, width: 320, height: 240, hasAudio: false })).toEqual(
      [
        "-vf",
        "format=rgb24,fps=10,scale=320:240:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
        "-loop",
        "0",
      ],
    );
  });

  test("custom output args are passed through", () => {
    expect(
      buildOutputArgs({
        isGif: false,
        fps: 25,
        width: 640,
        height: 360,
        hasAudio: false,
        customOutputArgs: ["-vcodec", "libvpx"],
      }),
    ).toEqual(["-vcodec", "libvpx"]);
  });

  test("custom output args must be an array", () => {
    expect(() =>
      buildOutputArgs({
        isGif: false,
        fps: 25,
        width: 640,
        height: 360,
        hasAudio: false,
        // @ts-expect-error testing invalid input
        customOutputArgs: "nope",
      }),
    ).toThrow("customOutputArgs must be an array of arguments");
  });
});

describe("buildWriterArgs", () => {
  test("rawvideo pipe input with audio mapped", () => {
    expect(
      buildWriterArgs({
        width: 640,
        height: 360,
        framerateStr: "25",
        audioFilePath: "audio.flac",
        isGif: false,
        outputArgs: ["-vcodec", "libx264"],
        outPath: "out.mp4",
      }),
    ).toEqual([
      "-f",
      "rawvideo",
      "-vcodec",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      "640x360",
      "-r",
      "25",
      "-i",
      "-",
      "-i",
      "audio.flac",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vcodec",
      "libx264",
      "-y",
      "out.mp4",
    ]);
  });

  test("gif without audio maps nothing", () => {
    const args = buildWriterArgs({
      width: 320,
      height: 240,
      framerateStr: "10",
      isGif: true,
      outputArgs: [],
      outPath: "out.gif",
    });
    expect(args).not.toContain("-map");
    expect(args).not.toContain("audio.flac");
  });
});
