import { apiClient } from "@/api/apiClient";
import { API_CONFIG } from "@/api/apiConfig";

export interface LoginPayload { username: string; password: string }
export interface AuthSession { token: string; user: { id: string; username?: string } }

/** Example of a domain service: pages call this, rather than calling apiClient directly. */
export const authService = {
  login: (payload: LoginPayload) => apiClient.post<AuthSession, LoginPayload>(API_CONFIG.auth.login, payload),
  profile: () => apiClient.get<AuthSession["user"]>(API_CONFIG.auth.profile),
};
