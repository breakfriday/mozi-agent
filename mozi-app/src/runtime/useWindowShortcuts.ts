import { useEffect } from "react";
import { bridgeApi } from "./bridge";

export function useWindowShortcuts() {
  useEffect(() => {
    if (!bridgeApi.available) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !document.hasFocus() ||
        event.isComposing ||
        !event.ctrlKey ||
        !event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.code !== "KeyI"
      ) return;

      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;

      void bridgeApi.window.openDevTools().catch((error: unknown) => {
        console.error("Failed to open window DevTools:", error);
      });
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
