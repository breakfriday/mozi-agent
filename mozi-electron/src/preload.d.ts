import type { ElectronApi } from "../../shared/electron-api";
export type { ElectronApi } from "../../shared/electron-api";
export type { MoziApi } from "../../shared/mozi-api";

declare global { interface Window { electronAPI?: ElectronApi } }
