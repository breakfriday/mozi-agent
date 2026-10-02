/** Keep endpoint paths together. Add domain groups here instead of scattering strings in pages. */
export const API_CONFIG = {
  health: "/health",
  auth: {
    login: "/auth/login",
    profile: "/auth/profile",
  },
} as const;
