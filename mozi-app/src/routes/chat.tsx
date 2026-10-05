import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/chat")({
  component: lazyRouteComponent(() => import("@/pages/chat/chat"), "ChatPage"),
});
