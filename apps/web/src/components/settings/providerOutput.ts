import type { ServerTraceDiagnosticsLogEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MAX_OUTPUT_CHARS = 64 * 1024;

function formatLogMessage(message: string): string {
  try {
    const value: unknown = JSON.parse(message);
    if (Array.isArray(value)) {
      return value
        .map((item: unknown) => (typeof item === "string" ? item : JSON.stringify(item, null, 2)))
        .join("\n");
    }
  } catch {
    // Other providers emit ordinary text rather than structured log arguments.
  }
  return message;
}

export function formatProviderOutput(input: {
  readonly headline: string;
  readonly detail: string | null;
  readonly logs: ReadonlyArray<ServerTraceDiagnosticsLogEvent>;
}): string {
  const logs = [...input.logs].sort(
    (a, b) => DateTime.toEpochMillis(a.seenAt) - DateTime.toEpochMillis(b.seenAt),
  );
  const text = [
    input.headline,
    input.detail,
    ...logs.map(
      (log) => `[${DateTime.formatIso(log.seenAt)}] ${log.level}\n${formatLogMessage(log.message)}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  return text.length > MAX_OUTPUT_CHARS
    ? `[Earlier output truncated]\n${text.slice(-MAX_OUTPUT_CHARS)}`
    : text;
}
