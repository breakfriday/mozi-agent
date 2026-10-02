/** Extend this facade from an Electron preload script; browser callers safely receive false/null. */
export const bridgeApi = {
  get available() { return Boolean((window as Window & { electronAPI?: unknown }).electronAPI); },
  window: { async openDevTools() { return false; } },
} as const;
