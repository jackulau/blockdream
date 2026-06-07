// Tiny leveled logger + perf timing for the web app. Default level is "warn", so a normal visitor
// sees a clean console (no noise); developers opt into detail with ?log=debug or
// localStorage.mw_log="debug". Perf timings (mesh build, voxelize, video decode) log at "debug".
// Centralizing this means the hot paths get consistent, gated instrumentation instead of scattered
// console.* calls (the app previously had none, so failures were silent).

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: LogLevel[] = ["debug", "info", "warn", "error", "silent"];

function resolveLevel(): LogLevel {
  try {
    const fromUrl = new URLSearchParams(location.search).get("log");
    const s = fromUrl ?? localStorage.getItem("mw_log") ?? "warn";
    return (ORDER as string[]).includes(s) ? (s as LogLevel) : "warn";
  } catch {
    return "warn";
  }
}

let level: LogLevel = resolveLevel();
const rank = (l: LogLevel): number => ORDER.indexOf(l);

function emit(l: Exclude<LogLevel, "silent">, args: unknown[]): void {
  if (rank(l) < rank(level)) return;
  const fn = (console[l] as ((...a: unknown[]) => void) | undefined) ?? console.log;
  fn("[mw]", ...args);
}

export const log = {
  setLevel(l: LogLevel): void {
    level = l;
  },
  get level(): LogLevel {
    return level;
  },
  debug: (...a: unknown[]): void => emit("debug", a),
  info: (...a: unknown[]): void => emit("info", a),
  warn: (...a: unknown[]): void => emit("warn", a),
  error: (...a: unknown[]): void => emit("error", a),
  /** Time a synchronous block; logs `label NNNms` at debug level. Returns the block's result. */
  time<T>(label: string, fn: () => T): T {
    const t0 = performance.now();
    const r = fn();
    emit("debug", [`${label} ${(performance.now() - t0).toFixed(1)}ms`]);
    return r;
  },
};
