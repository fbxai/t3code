export const CONNECTION_LOG_MAX_CHARS = 32_768;
export const CONNECTION_LOG_MAX_AGE_MS = 60 * 60_000;

/** Remove credentials before connection output enters either local cache. */
export function redactConnectionLog(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(\bBearer\s+)[^\s"',}\]]+/gi, "$1[redacted]")
    .replace(
      /((?:[?&#]|\b)(?:(?:(?:access|refresh|bearer|pairing|bootstrap)[_-]?)?token|credential|secret|password|code)=)[^\s"'&#]+/gi,
      "$1[redacted]",
    )
    .replace(
      /((?:\\?"|\b)(?:(?:(?:access|refresh|bearer|pairing|bootstrap)[_-]?)?token|credential|password|secret)\\?"?\s*:\s*\\?")[^"\r\n]*(\\?")/gi,
      "$1[redacted]$2",
    )
    .replace(/(pairing\s*url:\s*)\S+/gi, "$1[redacted]")
    .slice(-CONNECTION_LOG_MAX_CHARS);
}
