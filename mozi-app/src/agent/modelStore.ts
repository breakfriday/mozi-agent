import { create } from "zustand";
import type { ModelSettings } from "../../../shared/agent";

export const useModelStore = create<{
  settings: ModelSettings | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
}>(() => ({ settings: null, loading: false, saving: false, error: null }));
