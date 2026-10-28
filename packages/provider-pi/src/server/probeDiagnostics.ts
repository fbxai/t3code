import { redactProviderFailureText } from "@t3tools/provider-core/server/failure";
import { errorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";

const PRIVATE_VALUE = /api.?key|token|secret|password|credential|authorization|prompt/i;

/** Keep probe output useful without persisting credentials from instance overrides. */
export function sanitizePiProbeText(
  text: string,
  environment: NodeJS.ProcessEnv,
  args: ReadonlyArray<string> = [],
): string {
  for (const [name, value] of Object.entries(environment)) {
    if (value && PRIVATE_VALUE.test(name)) text = text.replaceAll(value, "[REDACTED]");
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (!flag.startsWith("-") || flag.startsWith("--no-") || !PRIVATE_VALUE.test(flag)) continue;
    const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
    if (value) text = text.replaceAll(value, "[REDACTED]");
  }
  return redactProviderFailureText(text).slice(0, 4096);
}

export function piProbeErrorMessage(
  error: unknown,
  environment: NodeJS.ProcessEnv,
  args: ReadonlyArray<string> = [],
): string {
  const messages: string[] = [];
  for (let depth = 0; error != null && depth < 5; depth++) {
    if (Cause.isCause(error)) error = Cause.squash(error);
    messages.push(error instanceof Error ? error.message : errorTag(error));
    error = typeof error === "object" && error !== null && "cause" in error ? error.cause : null;
  }
  return sanitizePiProbeText(messages.join(" ← "), environment, args);
}

export function piProbeDiagnostics(input: {
  readonly phase: "version" | "rpc-discovery";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly hostname: string;
  readonly platform: NodeJS.Platform;
  readonly timeoutMs: number;
}) {
  const clean = (text: string) => sanitizePiProbeText(text, input.environment, input.args);
  let hideNext = false;
  const args = input.args.map((arg) => {
    if (hideNext) {
      hideNext = false;
      return "[REDACTED]";
    }
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (flag.startsWith("-") && !flag.startsWith("--no-") && PRIVATE_VALUE.test(flag)) {
      if (equals >= 0) return `${flag}=[REDACTED]`;
      hideNext = true;
    }
    return clean(arg);
  });
  const quote = (word: string) =>
    input.platform === "win32"
      ? `'${word.replace(/['\u2018\u2019]/g, "$&$&")}'`
      : `'${word.replaceAll("'", "'\\''")}'`;
  const command = clean(input.command);
  const cwd = clean(input.cwd);
  const path = clean(input.environment.PATH ?? input.environment.Path ?? "");
  const homeVariable = input.environment.HOME === undefined ? "USERPROFILE" : "HOME";
  const home = clean(input.environment[homeVariable] ?? "");
  const commandLine = `${input.platform === "win32" ? "& " : ""}${[command, ...args].map(quote).join(" ")}`;
  const reproduce =
    input.platform === "win32"
      ? `Set-Location -LiteralPath ${quote(cwd)}\n$env:PATH = ${quote(path)}\n${home ? `$env:${homeVariable} = ${quote(home)}\n` : ""}${commandLine}`
      : `cd ${quote(cwd)} && env PATH=${quote(path)}${home ? ` ${homeVariable}=${quote(home)}` : ""} ${commandLine}`;
  return {
    phase: input.phase,
    command,
    args,
    cwd,
    hostname: clean(input.hostname),
    platform: input.platform,
    PATH: path,
    [homeVariable]: home,
    timeoutMs: input.timeoutMs,
    commandLine,
    reproduce,
    ...(input.phase === "rpc-discovery"
      ? {
          stdin: ["get_state", "get_available_models", "get_commands"].map((type, index) =>
            JSON.stringify({ type, id: `t3-${index}` }),
          ),
        }
      : {}),
  };
}
