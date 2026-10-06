// The pinned package publishes TS source with readonly model arrays. Its runtime
// factory uses the standard ExtensionAPI; keep dependency typing at this boundary.
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
declare const register: ExtensionFactory;
export default register;
