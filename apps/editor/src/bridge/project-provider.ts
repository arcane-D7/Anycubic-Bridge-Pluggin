import type { BridgeHandle } from "./mock.ts";

export type ProjectProviderMode = "demo" | "real" | "unavailable";

export interface ProjectProviderDescriptor {
  readonly mode: ProjectProviderMode;
  readonly origin: "demo-fixture" | "tauri-project-store" | "none";
  readonly available: boolean;
  readonly contractVersion: 1;
  readonly capabilities: readonly string[];
  readonly reason?: "real-project-provider-not-connected" | "unknown-project-provider";
}

export interface ProjectBootstrap {
  readonly provider: ProjectProviderDescriptor;
  readonly scene?: BridgeHandle;
}

export function selectProjectProvider(input: {
  readonly requested?: string | null;
  readonly isTauri: boolean;
}): ProjectProviderDescriptor {
  const requested = input.requested?.trim().toLowerCase();
  const mode: ProjectProviderMode =
    requested === "demo" || (!requested && !input.isTauri)
      ? "demo"
      : requested === "real" || !requested
        ? "real"
        : "unavailable";

  if (mode !== "demo") {
    const knownRealRequest = mode === "real";
    return {
      mode,
      origin: knownRealRequest ? "tauri-project-store" : "none",
      available: false,
      contractVersion: 1,
      capabilities: [],
      reason: knownRealRequest ? "real-project-provider-not-connected" : "unknown-project-provider",
    };
  }

  return {
    mode,
    origin: "demo-fixture",
    available: true,
    contractVersion: 1,
    capabilities: ["scene.read", "scene.mutate.demo", "scene.arrange.demo", "scene.slice.estimate"],
  };
}

export async function bootstrapProject(input: {
  readonly requested?: string | null;
  readonly isTauri: boolean;
}): Promise<ProjectBootstrap> {
  const provider = selectProjectProvider(input);
  if (!provider.available) return { provider };
  if (!demoScene) {
    demoScene = import("./mock.ts").then(({ fetchSceneSnapshot }) => fetchSceneSnapshot());
  }
  return { provider, scene: await demoScene };
}

let demoScene: Promise<BridgeHandle> | undefined;

export function activeProjectRequest() {
  return { requested: requestedProjectProvider(), isTauri: isTauriRuntime() };
}

export function activeProjectProvider(): ProjectProviderDescriptor {
  return selectProjectProvider(activeProjectRequest());
}

export async function activeProjectScene(): Promise<BridgeHandle> {
  const bootstrap = await bootstrapProject(activeProjectRequest());
  if (!bootstrap.scene) {
    throw new Error(bootstrap.provider.reason ?? "project provider unavailable");
  }
  return bootstrap.scene;
}

export function requestedProjectProvider(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("provider");
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
