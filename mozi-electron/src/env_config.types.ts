export type RendererEntry =
  | { type: "url"; url: string }
  | { type: "file"; filePath: string; hash: string };
