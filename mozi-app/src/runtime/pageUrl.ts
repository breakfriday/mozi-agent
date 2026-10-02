export const isFileLocalRuntime = import.meta.env.MODE === "filelocal";
export const routerBasepath = isFileLocalRuntime ? "/" : import.meta.env.BASE_URL;

export function createPageUrl(routePath: string, search: Record<string, string> = {}) {
  const route = routePath.replace(/^\/+/, "");
  const query = new URLSearchParams(search).toString();
  if (isFileLocalRuntime) {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = `/${route}${query ? `?${query}` : ""}`;
    return url.toString();
  }
  const url = new URL(`${routerBasepath}${route}`, window.location.origin);
  url.search = query;
  return url.toString();
}
