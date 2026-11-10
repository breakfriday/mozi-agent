import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SessionViewerDependencies {
  sessionRoot?: string;
  webRoot?: string;
  openBrowser?: (url: string) => Promise<void> | void;
}

export declare function registerExtension(
  pi: ExtensionAPI,
  dependencies?: SessionViewerDependencies,
): void;

declare const extension: (pi: ExtensionAPI) => void;
export default extension;
