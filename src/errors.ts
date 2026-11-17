const DEFAULT_MAX_LOG_LINES = 20;

/**
 * Returns the last non-empty lines of a (possibly huge) log output,
 * so error messages stay readable while still showing the relevant part.
 */
export function getLogTail(text: unknown, maxLines = DEFAULT_MAX_LOG_LINES): string {
  if (text == null) return "";
  const str = typeof text === "string" ? text : String(text);
  const lines = str.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-maxLines).join("\n");
}

type ProcessErrorLike = {
  shortMessage?: unknown;
  stderr?: unknown;
};

/**
 * Wraps an error with human-readable context about which stage failed,
 * appending the tail of the ffmpeg/ffprobe log so the failure can be located.
 * The original error is preserved as `cause`.
 */
export function withErrorContext(err: unknown, context: string, log?: unknown): Error {
  const processErr = err as ProcessErrorLike | null | undefined;

  const base =
    typeof processErr?.shortMessage === "string"
      ? processErr.shortMessage
      : err instanceof Error
        ? err.message
        : String(err);

  const tail = getLogTail(log ?? processErr?.stderr);

  const message = `${context}: ${base}${tail ? `\nLast log output:\n${tail}` : ""}`;

  return new Error(message, { cause: err });
}

/**
 * Captures the tail of a stderr stream (while optionally passing it through
 * to our own stderr), so it can be included in error messages even when the
 * process output is not buffered.
 */
export function createLogCapture({
  passthrough = true,
  maxLines = 100,
}: { passthrough?: boolean; maxLines?: number } = {}) {
  let captured = "";

  const handleData = (chunk: Buffer | string) => {
    const str = chunk.toString();
    if (passthrough) process.stderr.write(str);
    captured = getLogTail(captured + str, maxLines);
  };

  return {
    handleData,
    getCaptured: () => captured,
  };
}
