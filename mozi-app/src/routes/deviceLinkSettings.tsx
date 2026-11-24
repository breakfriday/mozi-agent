import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/deviceLinkSettings")({
  component: lazyRouteComponent(
    () => import("@/features/device-link-settings/DeviceLinkSettingsPage"),
    "DeviceLinkSettingsPage",
  ),
});
