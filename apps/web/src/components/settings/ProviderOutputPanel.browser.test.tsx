import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerTraceDiagnosticsLogEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  allowed: true,
  error: null as string | null,
  logs: [] as ServerTraceDiagnosticsLogEvent[],
  refresh: vi.fn(),
  read: vi.fn((input: unknown) => input),
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.allowed,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, traceDiagnostics: state.read as never },
  };
});
vi.mock(import("../../state/query"), async (original) => {
  const Option = await import("effect/Option");
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: unknown) => ({
      data: atom ? { providerLogs: state.logs, error: Option.none() } : null,
      error: state.error,
      isPending: false,
      refresh: state.refresh,
    })) as never,
  };
});
vi.mock("./ProviderModelsSection", () => ({ ProviderModelsSection: () => null }));

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { ProviderOutputPanel } from "./ProviderOutputPanel";

const environmentId = EnvironmentId.make("remote-4070");
const instanceId = ProviderInstanceId.make("omp");
const driver = ProviderDriverKind.make("pi");
const detail =
  "Pi CLI could not start. Reproduce on nvtest-4070: '/home/operator/.local/bin/omp' '--version'.";
const provider: ServerProvider = {
  instanceId,
  driver,
  displayName: "OMP",
  enabled: true,
  installed: false,
  status: "error",
  version: null,
  checkedAt: "2026-10-26T15:00:00Z",
  auth: { status: "unknown" },
  models: [],
  skills: [],
  slashCommands: [],
  message: detail,
};
const noop = () => {};

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <input aria-label="Outside setting" />
      <ProviderInstanceCard
        instanceId={instanceId}
        instance={{ driver, displayName: "OMP", enabled: true }}
        driverOption={undefined}
        liveProvider={provider}
        mode="editor"
        onUpdate={noop}
        onShowOutput={() => setOpen(true)}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={noop}
        onFavoriteModelsChange={noop}
        onToggleFavorite={noop}
        onModelOrderChange={noop}
      />
      {open ? (
        <ProviderOutputPanel
          environmentId={environmentId}
          environmentLabel="nvtest-4070"
          instanceId={instanceId}
          label="OMP"
          provider={provider}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function setup() {
  state.allowed = true;
  state.error = null;
  state.logs = [];
  vi.clearAllMocks();
}

describe("provider output panel", () => {
  it("keeps the editor compact and exposes full output on demand", async () => {
    setup();
    state.logs = [
      {
        spanName: "probe",
        traceId: "trace",
        spanId: "span",
        level: "WARN",
        seenAt: DateTime.makeUnsafe("2026-10-26T15:00:00Z"),
        message: "spawn ENOENT <img src=x>",
      },
    ];
    using writeClipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await using screen = await render(<Harness />);
    expect(screen.container.textContent).toContain("Not found");
    expect(screen.container.textContent).not.toContain("Reproduce on");
    const showOutput = screen.getByRole("button", { name: "Show logs / errors for OMP" });
    await userEvent.click(showOutput);
    const panel = page.getByRole("region", { name: "Provider output" });
    await expect.element(panel).toBeVisible();
    expect(panel.element().textContent).toContain(detail);
    expect(panel.element().textContent).toContain("spawn ENOENT <img src=x>");
    expect(panel.element().querySelector("img")).toBeNull();
    expect(state.read).toHaveBeenCalledWith({
      environmentId,
      input: { providerInstanceId: instanceId },
    });
    await userEvent.click(page.getByRole("button", { name: "Copy output" }));
    expect(writeClipboard).toHaveBeenCalledWith(expect.stringContaining("spawn ENOENT"));
    await userEvent.click(page.getByRole("button", { name: "Refresh logs" }));
    expect(state.refresh).toHaveBeenCalledOnce();
    await userEvent.type(screen.getByRole("textbox", { name: "Outside setting" }), "editable");
    await expect
      .element(screen.getByRole("textbox", { name: "Outside setting" }))
      .toHaveValue("editable");
    await userEvent.click(page.getByRole("button", { name: "Close provider output" }));
    await expect.element(panel).not.toBeInTheDocument();
    await expect.element(showOutput).toHaveFocus();
    await userEvent.click(showOutput);
    await userEvent.keyboard("{Escape}");
    await expect.element(panel).not.toBeInTheDocument();
  });

  it("keeps the current diagnostic available without server log permission", async () => {
    setup();
    state.allowed = false;
    await using screen = await render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Show logs / errors for OMP" }));
    const panel = page.getByRole("region", { name: "Provider output" });
    await expect.element(panel).toBeVisible();
    expect(panel.element().textContent).toContain(detail);
    expect(panel.element().textContent).toContain("does not have permission");
    expect(state.read).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Refresh logs" })).toBeDisabled();
  });

  it("shows log-read failures without losing the provider error", async () => {
    setup();
    state.error = "Environment disconnected";
    await using screen = await render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Show logs / errors for OMP" }));
    await expect.element(page.getByRole("alert")).toHaveTextContent("Environment disconnected");
    expect(page.getByRole("region", { name: "Provider output" }).element().textContent).toContain(
      detail,
    );
  });

  it("reports a failed copy while leaving the output available to select", async () => {
    setup();
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    using _writeClipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("Clipboard denied"));
    await using screen = await render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Show logs / errors for OMP" }));
    await userEvent.click(page.getByRole("button", { name: "Copy output" }));
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(page.getByRole("region", { name: "Provider output" }).element().textContent).toContain(
      detail,
    );
  });
});
