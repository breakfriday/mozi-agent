import { createBrowserHistory, createHashHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { AppProviders } from "@/app/providers";
import { isFileLocalRuntime, routerBasepath } from "@/runtime/pageUrl";
import { routeTree } from "./routeTree.gen";

const router = createRouter({
  routeTree,
  basepath: routerBasepath,
  history: isFileLocalRuntime ? createHashHistory() : createBrowserHistory(),
});

declare module "@tanstack/react-router" { interface Register { router: typeof router } }

export function App() {
  return <AppProviders><RouterProvider router={router} /></AppProviders>;
}
