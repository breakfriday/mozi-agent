import { create } from "zustand";

export type AppTheme = "light" | "dark";
const storageKey = "dual-vite:theme";
function syncDocumentTheme(theme: AppTheme) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
}

const initialTheme = (): AppTheme => {
  const theme =
    typeof window !== "undefined" &&
    window.localStorage.getItem(storageKey) === "light"
      ? "light"
      : "dark";
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
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
}));
