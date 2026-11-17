import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/ttsSettings")({
  component: lazyRouteComponent(() => import("@/features/tts-settings/TtsSettingsPage"), "TtsSettingsPage"),
});
