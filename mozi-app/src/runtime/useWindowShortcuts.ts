import { useEffect } from "react";
import { handleActionKeyDown } from "@/config/action-config";
import { bridgeApi } from "./bridge";

export function useWindowShortcuts() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        bridgeApi.available &&
        document.hasFocus() &&
        !event.isComposing &&
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.code === "KeyI"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          void bridgeApi.window.openDevTools().catch((error: unknown) => {
            console.error("Failed to open window DevTools:", error);
          });
        }
        return;
      }

      handleActionKeyDown(event);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
