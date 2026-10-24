import type { DesktopSshEnvironmentLogs, DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { redactConnectionLog } from "@t3tools/shared/connectionLogs";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import {
  clearConnectionLogCache,
  readConnectionLogCache,
  sshLogCacheKey,
  writeConnectionLogCache,
} from "./connectionLogStorage";

export function ConnectionLogsDialog({
  target,
  label,
  clientError = null,
  onClose,
}: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label: string;
  readonly clientError?: string | null;
  readonly onClose: () => void;
}) {
  const key = sshLogCacheKey(target);
  const [snapshot, setSnapshot] = useState(() => readConnectionLogCache(key));
  const [error, setError] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(false);
  const epoch = useRef(0);
  const latest = useRef(snapshot);
  const bridge = window.desktopBridge;

  useEffect(() => {
    const readLogs = bridge?.readSshEnvironmentLogs;
    if (!readLogs) return;
    let disposed = false;
    let localBusy = false;
    const accept = (logs: DesktopSshEnvironmentLogs, requestEpoch: number) => {
      if (disposed || clearingRef.current || requestEpoch !== epoch.current) return;
      const previous = latest.current;
      if (
        previous?.logs.local === logs.local &&
        previous.logs.remote === logs.remote &&
        previous.logs.remoteError === logs.remoteError &&
        previous.clientError === clientError
      )
        return;
      latest.current = { logs, clientError };
      setSnapshot(latest.current);
      writeConnectionLogCache(key, logs, clientError);
      setError(null);
    };
    const readLocal = async () => {
      if (localBusy || clearingRef.current) return;
      const requestEpoch = epoch.current;
      localBusy = true;
      try {
        accept(await readLogs(target), requestEpoch);
      } catch (cause) {
        if (!disposed && requestEpoch === epoch.current)
          setError(redactConnectionLog(String(cause)));
      } finally {
        localBusy = false;
      }
    };
    void readLocal();
    const requestEpoch = epoch.current;
    void readLogs(target, true)
      .then(
        (logs) => accept(logs, requestEpoch),
        (cause) => {
          if (!disposed && requestEpoch === epoch.current)
            setError(redactConnectionLog(String(cause)));
        },
      )
      .finally(() => {
        if (!disposed && requestEpoch === epoch.current) setRemoteBusy(false);
      });
    const timer = window.setInterval(() => void readLocal(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- Refresh deliberately restarts the one-shot remote read.
  }, [bridge, key, target, refresh, clientError]);

  const clear = async () => {
    if (!bridge?.clearSshEnvironmentLogs) return;
    clearingRef.current = true;
    epoch.current += 1;
    setClearing(true);
    try {
      await bridge.clearSshEnvironmentLogs(target);
      clearConnectionLogCache(key);
      setSnapshot(null);
      latest.current = null;
      setError(null);
    } catch (cause) {
      setError(redactConnectionLog(String(cause)));
    } finally {
      clearingRef.current = false;
      setClearing(false);
      setRemoteBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connection logs: {label}</DialogTitle>
          <DialogDescription>
            Recent SSH setup and remote server output. Cached on this device for this app session,
            for up to one hour.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={remoteBusy || clearing}
                onClick={() => {
                  setRemoteBusy(true);
                  setRefresh((value) => value + 1);
                }}
              >
                {remoteBusy ? "Reading remote log…" : "Refresh remote log"}
              </Button>
              <Button size="sm" variant="ghost" disabled={clearing} onClick={() => void clear()}>
                Clear cached logs
              </Button>
              <span className="text-xs text-muted-foreground">Setup updates automatically</span>
            </div>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            {(clientError ?? snapshot?.clientError) ? (
              <LogOutput
                title="Client connection error"
                text={redactConnectionLog(clientError ?? snapshot?.clientError ?? "")}
              />
            ) : null}
            <LogOutput
              title="SSH setup"
              text={
                snapshot?.logs.local ||
                "No setup messages captured yet. Retry the connection to record an attempt."
              }
            />
            {snapshot?.logs.remoteError ? (
              <p role="alert" className="text-xs text-destructive">
                Could not read the remote log: {snapshot.logs.remoteError}
              </p>
            ) : null}
            <LogOutput
              title="Remote server"
              text={
                snapshot?.logs.remote ||
                "No remote server output captured. A startup log is available once the SSH launcher starts a server."
              }
            />
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function LogOutput({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      <pre
        tabIndex={0}
        aria-label={title}
        className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words select-text"
      >
        {text}
      </pre>
    </section>
  );
}
