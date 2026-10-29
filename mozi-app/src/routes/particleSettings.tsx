import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
export const Route = createFileRoute("/particleSettings")({
  component: lazyRouteComponent(() => import("@/features/particle-settings/ParticleSettingsPage"), "ParticleSettingsPage"),
});
