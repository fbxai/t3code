import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CopyIcon, RefreshCwIcon, XIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { getProviderSummary } from "./providerStatus";
import { formatProviderOutput } from "./providerOutput";

export function ProviderOutputPanel({
  environmentId,
  environmentLabel,
  instanceId,
  label,
  provider,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly provider: ServerProvider | undefined;
  readonly onClose: () => void;
}) {
  const canReadLogs = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    canReadLogs
      ? serverEnvironment.traceDiagnostics({
          environmentId,
          input: { providerInstanceId: instanceId },
        })
      : null,
  );
  const summary = getProviderSummary(provider);
  const text = formatProviderOutput({ ...summary, logs: data?.providerLogs ?? [] });
  const [copyError, setCopyError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "provider output",
    onCopy: () => setCopyError(null),
    onError: (error) => setCopyError(error.message),
  });
  const panel = useRef<HTMLElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own DOM focus while mounted and restore the invoking control on close.
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  const traceError = data ? Option.getOrNull(data.error)?.message : null;

  return createPortal(
    <section
      ref={panel}
      tabIndex={-1}
      role="region"
      aria-label="Provider output"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
      className="fixed inset-x-0 bottom-0 z-(--z-sheet) flex h-80 max-h-[50dvh] min-h-0 flex-col border-t border-border bg-background shadow-lg outline-none"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold">Output</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {label} · {environmentLabel}
        </span>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canReadLogs || isPending}
          onClick={refresh}
        >
          <RefreshCwIcon />
          {isPending ? "Reading…" : "Refresh logs"}
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={() => void copyToClipboard(text)}>
          <CopyIcon />
          {isCopied ? "Copied" : "Copy output"}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Close provider output"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1" scrollFade={false}>
        <div className="space-y-3 p-4">
          {!canReadLogs ? (
            <p className="text-xs text-muted-foreground">
              Your connection can view the provider status but does not have permission to read
              server logs.
            </p>
          ) : null}
          {error || traceError ? (
            <p role="alert" className="text-xs text-destructive">
              {error ?? traceError}
            </p>
          ) : null}
          {copyError ? (
            <p role="alert" className="text-xs text-destructive">
              {copyError}
            </p>
          ) : null}
          <pre className="font-mono text-xs whitespace-pre-wrap break-words select-text">
            {text}
          </pre>
          {canReadLogs && !isPending && !error && !traceError && !data?.providerLogs?.length ? (
            <p className="text-xs text-muted-foreground">
              {data && data.providerLogs === undefined
                ? "Update this server to include provider logs here. Its current diagnostic is shown above."
                : "No recent server output is available for this provider. Its current diagnostic is shown above."}
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </section>,
    document.body,
  );
}
