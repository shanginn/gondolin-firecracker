import { performance } from "node:perf_hooks";

export type StartupTimingEntry = {
  /** startup phase name */
  name: string;
  /** elapsed time from startup timing reset in `ms` */
  atMs: number;
};

export type StartupTimingRecorder = {
  /** reset the timing origin */
  resetStartupTimings(): void;
  /** record a startup phase */
  recordStartupTiming(name: string): StartupTimingEntry;
  /** startup phases recorded so far */
  getStartupTimings(): StartupTimingEntry[];
};

export function nowMs(): number {
  return performance.now();
}
