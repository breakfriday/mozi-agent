/** Small, presentation-only contract. Agent payloads stay in the main process. */
export type ParticleNotice = {
  key: string;
  text: string;
  tone: "activity" | "success" | "attention";
};

export const PARTICLE_STYLES = ["auto", "meteor", "firework", "ink", "vortex", "aurora", "ring", "still"] as const;
export type ParticleSettings = {
  style: typeof PARTICLE_STYLES[number];
  wallpaper: string | null;
  paused: boolean;
  cruise: boolean;
  depth: number;
};
export const DEFAULT_PARTICLE_SETTINGS: ParticleSettings = { style: "auto", wallpaper: null, paused: false, cruise: true, depth: 1 };
export interface ParticleSettingsApi {
  get(): Promise<ParticleSettings>;
  save(settings: ParticleSettings): Promise<void>;
  chooseWallpaper(): Promise<string | null>;
}
export const PARTICLE_SETTINGS_CHANNELS = { get: "particle-settings:get", save: "particle-settings:save", choose: "particle-settings:choose" } as const;

export function parseParticleSettings(value: unknown): ParticleSettings {
  if (!value || typeof value !== "object") throw new Error("Invalid particle settings");
  const s = value as Record<string, unknown>;
  if (!PARTICLE_STYLES.includes(s.style as ParticleSettings["style"]) ||
      (s.wallpaper !== null && typeof s.wallpaper !== "string") ||
      typeof s.paused !== "boolean" || typeof s.cruise !== "boolean" ||
      typeof s.depth !== "number" || !Number.isFinite(s.depth) || s.depth < 0 || s.depth > 3) {
    throw new Error("Invalid particle settings");
  }
  return { style: s.style as ParticleSettings["style"], wallpaper: s.wallpaper as string | null, paused: s.paused, cruise: s.cruise, depth: s.depth };
}
