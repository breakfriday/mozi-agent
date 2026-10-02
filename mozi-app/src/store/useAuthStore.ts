import { create } from "zustand";

export interface AuthUser { id: string; username?: string; [key: string]: unknown }
interface AuthState { token: string; user: AuthUser | null; setAuth: (payload: { token: string; user: AuthUser }) => void; clearAuth: () => void }
const tokenKey = "dual-vite:token";
const userKey = "dual-vite:user";
function getUser(): AuthUser | null { try { const value = localStorage.getItem(userKey); return value ? JSON.parse(value) as AuthUser : null; } catch { return null; } }

export const useAuthStore = create<AuthState>((set) => ({
  token: typeof window === "undefined" ? "" : localStorage.getItem(tokenKey) || "",
  user: typeof window === "undefined" ? null : getUser(),
  setAuth: ({ token, user }) => { localStorage.setItem(tokenKey, token); localStorage.setItem(userKey, JSON.stringify(user)); set({ token, user }); },
  clearAuth: () => { localStorage.removeItem(tokenKey); localStorage.removeItem(userKey); set({ token: "", user: null }); },
}));
