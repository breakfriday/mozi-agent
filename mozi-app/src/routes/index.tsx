import { createFileRoute } from "@tanstack/react-router";
import { Homepage } from "@/pages/homepage/Homepage";

export const Route = createFileRoute("/")({ component: Homepage });
