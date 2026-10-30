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

/** Current visible content, independent of Agent event schemas. Null clears the field. */
export type ParticleProjection = { key: string; text: string; role: "user" | "assistant" | "activity"; streaming: boolean };
export const PARTICLE_PROJECTION_CHANNEL = "particles:project";
export function parseParticleProjection(input: unknown): ParticleProjection | null {
  if (input === null) return null;
  if (!input || typeof input !== "object") throw new Error("Invalid projection");
  const p = input as Record<string, unknown>;
  if (typeof p.key !== "string" || p.key.length > 1024 || typeof p.text !== "string" || p.text.length > 131072 ||
      !["user", "assistant", "activity"].includes(p.role as string) || typeof p.streaming !== "boolean") throw new Error("Invalid projection");
  return { key: p.key, text: p.text, role: p.role as ParticleProjection["role"], streaming: p.streaming };
}
