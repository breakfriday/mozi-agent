import { create } from "zustand";

export type AppTheme = "light" | "dark";
const storageKey = "dual-vite:theme";
const initialTheme = (): AppTheme => typeof window !== "undefined" && window.localStorage.getItem(storageKey) === "light" ? "light" : "dark";

interface ThemeState { theme: AppTheme; setTheme: (theme: AppTheme) => void; toggleTheme: () => void }
export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme(),
  setTheme: (theme) => { window.localStorage.setItem(storageKey, theme); set({ theme }); },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
}));
