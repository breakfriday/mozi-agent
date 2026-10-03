export interface ElectronApi {
  app: { quit(): void };
  window: { minimize(): void; close(): void; openDevTools(): Promise<boolean> };
}

declare global { interface Window { electronAPI?: ElectronApi } }
