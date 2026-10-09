// Adapted from the official assistant-ui registry (2026-10-09).
// MIT license: ../LICENSE. Behavior retained; styles use the Mozi theme.
import { useEffect, useLayoutEffect } from "react";

const hasWindow =
  typeof (globalThis as typeof globalThis & { window?: unknown }).window !==
  "undefined";

export const useIsomorphicLayoutEffect = hasWindow
  ? useLayoutEffect
  : useEffect;
