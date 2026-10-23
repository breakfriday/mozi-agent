import { create } from "zustand";

export const themeOptions = [
  { key: "light", label: "默认浅色" },
  { key: "dark", label: "默认深色" },
  { key: "gruvbox-light", label: "Gruvbox 浅色" },
  { key: "gruvbox-dark", label: "Gruvbox 深色" },
] as const;
export type AppTheme = (typeof themeOptions)[number]["key"];
export const isAppTheme = (value: unknown): value is AppTheme => themeOptions.some(option => option.key === value);
export const isDarkTheme = (theme: AppTheme) => theme === "dark" || theme === "gruvbox-dark";
const storageKey = "dual-vite:theme";
function syncDocumentTheme(theme: AppTheme) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", isDarkTheme(theme));
  }
}

const initialTheme = (): AppTheme => {
  const saved = typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
  const theme = isAppTheme(saved) ? saved : "dark";
  syncDocumentTheme(theme);
  return theme;
};

interface ThemeState {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
}
export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme(),
  setTheme: (theme) => {
    window.localStorage.setItem(storageKey, theme);
    syncDocumentTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    const current = get().theme;
    const next: AppTheme = current.startsWith("gruvbox-")
      ? (isDarkTheme(current) ? "gruvbox-light" : "gruvbox-dark")
      : (isDarkTheme(current) ? "light" : "dark");
    get().setTheme(next);
  },
}));
