import { execa } from "execa";
import fsExtra from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getLogTail } from "../src/errors.js";
import { readDuration } from "../src/ffmpeg.js";
import Editly from "../src/index.js";

const TEST_TIMEOUT = 120 * 1000;

let workDir: string;

beforeEach(async () => {
  workDir = await fsExtra.mkdtemp(join(tmpdir(), "editly-failure-test-"));
});

afterEach(async () => {
  await fsExtra.remove(workDir);
});

/** Temp dirs created by editly runs inside workDir */
async function getLeftoverTmpDirs() {
  return (await fsExtra.readdir(workDir)).filter((f) => f.startsWith("editly-tmp-"));
}

/** Runs Editly and returns the rejection error (fails the test if it resolves) */
async function expectEditlyToFail(config: Parameters<typeof Editly>[0]): Promise<Error> {
  return Editly(config).then(
    () => {
      throw new Error("Expected Editly to fail, but it succeeded");
    },
    (err) => err as Error,
  );
}

/**
 * Creates a fake `ffmpeg` executable that forwards everything to the real ffmpeg,
 * except invocations whose arguments match `failOnArgPattern` (glob), which fail
 * with a simulated disk-full (ENOSPC) error.
 */
async function createFakeFfmpeg(failOnArgPattern: string) {
  const binDir = join(workDir, "bin");
  await fsExtra.mkdirp(binDir);
  const fakePath = join(binDir, "ffmpeg");
  const script = `#!/bin/sh
# Fault-injecting ffmpeg wrapper used by tests (simulates disk full)
for arg in "$@"; do
  case "$arg" in
    ${failOnArgPattern})
      echo "Error while opening encoder for output file: No space left on device" >&2
      exit 1
      ;;
  esac
done
exec ffmpeg "$@"
`;
  await fsExtra.writeFile(fakePath, script, { mode: 0o755 });
  return fakePath;
}

async function createAudioFile() {
  const audioPath = join(workDir, "tone.mp3");
  await execa("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-y",
    audioPath,
  ]);
  return audioPath;
}

describe("getLogTail", () => {
  test("keeps the last non-empty lines", () => {
    expect(getLogTail("a\n\nb\nc\n", 2)).toBe("b\nc");
    expect(getLogTail("1\n2\n3\n4")).toBe("1\n2\n3\n4");
  });

  test("handles empty and non-string input", () => {
    expect(getLogTail(undefined)).toBe("");
    expect(getLogTail("")).toBe("");
    expect(getLogTail(Buffer.from("x\ny"), 1)).toBe("y");
  });
});

test(
  "broken input asset: fails with a readable error and leaves no garbage",
  async () => {
    const brokenVideo = join(workDir, "broken.mp4");
    await fsExtra.writeFile(brokenVideo, "this is not a video file");
    const outPath = join(workDir, "out.mp4");

    const err = await expectEditlyToFail({
      outPath,
      fast: true,
      clips: [{ layers: [{ type: "video", path: brokenVideo }] }],
    });

    // Error must identify the offending file
    expect(err.message).toMatch(/broken\.mp4/);

    // User input assets must be preserved
    expect(await fsExtra.pathExists(brokenVideo)).toBe(true);

    // No half-written output or leftover temp dirs
    expect(await fsExtra.pathExists(outPath)).toBe(false);
    expect(await getLeftoverTmpDirs()).toEqual([]);
  },
  TEST_TIMEOUT,
);

test(
  "disk full during audio processing: cleans up temp files, error has context and ffmpeg log",
  async () => {
    const audioPath = await createAudioFile();
    const fakeFfmpeg = await createFakeFfmpeg("*.flac");
    const outPath = join(workDir, "out.mp4");

    const err = await expectEditlyToFail({
      outPath,
      fast: true,
      ffmpegPath: fakeFfmpeg,
      clips: [{ layers: [{ type: "title", text: "hello" }], duration: 1 }],
      audioTracks: [{ path: audioPath }],
    });

    // Error must say which stage failed and include the ffmpeg log
    expect(err.message).toMatch(/audio/i);
    expect(err.message).toMatch(/No space left on device/);

    // User input assets must be preserved
    expect(await fsExtra.pathExists(audioPath)).toBe(true);

    // No intermediate audio files or half-written output left behind
    expect(await getLeftoverTmpDirs()).toEqual([]);
    expect(await fsExtra.pathExists(outPath)).toBe(false);
  },
  TEST_TIMEOUT,
);

test(
  "disk full during final encoding: cleans up temp files and partial output, error has context and ffmpeg log",
  async () => {
    const fakeFfmpeg = await createFakeFfmpeg("*.mp4");
    const outPath = join(workDir, "out.mp4");

    const err = await expectEditlyToFail({
      outPath,
      fast: true,
      ffmpegPath: fakeFfmpeg,
      clips: [{ layers: [{ type: "title", text: "hello" }], duration: 1 }],
    });

    // Error must say which stage failed and include the ffmpeg log
    expect(err.message).toMatch(/Encoding output video failed/);
    expect(err.message).toMatch(/No space left on device/);

    // No leftover temp dirs or half-written output
    expect(await getLeftoverTmpDirs()).toEqual([]);
    expect(await fsExtra.pathExists(outPath)).toBe(false);
  },
  TEST_TIMEOUT,
);

test(
  "successful render: output is produced and temp files are cleaned up",
  async () => {
    const audioPath = await createAudioFile();
    const outPath = join(workDir, "out.mp4");

    await Editly({
      outPath,
      fast: true,
      clips: [
        { layers: [{ type: "title", text: "Success" }], duration: 1 },
        { layers: [{ type: "title", text: "Works" }], duration: 1 },
      ],
      audioTracks: [{ path: audioPath }],
    });

    expect(await fsExtra.pathExists(outPath)).toBe(true);
    expect((await fsExtra.stat(outPath)).size).toBeGreaterThan(0);
    expect(await readDuration(outPath)).toBeGreaterThan(1);
    expect(await getLeftoverTmpDirs()).toEqual([]);
  },
  TEST_TIMEOUT,
);
