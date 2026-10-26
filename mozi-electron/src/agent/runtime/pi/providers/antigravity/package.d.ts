declare module "pi-antigravity/src/auth/oauth.js" {
  type OAuth = NonNullable<import("@earendil-works/pi-coding-agent").ProviderConfig["oauth"]>;
  export const loginAntigravity: OAuth["login"];
  export const refreshAntigravityToken: OAuth["refreshToken"];
  export const getApiKey: OAuth["getApiKey"];
}
declare module "pi-antigravity/src/models/models.js" {
  export function getCurrentAntigravityModels(): NonNullable<import("@earendil-works/pi-coding-agent").ProviderConfig["models"]>;
}
declare module "pi-antigravity/src/models/discovery.js" {
  export const refreshAntigravityModels: NonNullable<import("@earendil-works/pi-coding-agent").ProviderConfig["refreshModels"]>;
}
declare module "pi-antigravity/src/stream/stream.js" {
  export const streamAntigravity: NonNullable<import("@earendil-works/pi-coding-agent").ProviderConfig["streamSimple"]>;
}
