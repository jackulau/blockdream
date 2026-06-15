/**
 * Pragmatic validator for the command forms blockdream emits. Not a full
 * Minecraft grammar - it accepts exactly the heads we generate and rejects
 * malformed lines, so a broken generator can't silently ship invalid commands.
 */

const INT = /^-?\d+$/;
const RANGE = /^(-?\d+)?\.\.(-?\d+)?$|^-?\d+$/;
const BLOCK = /^(minecraft:)?[a-z_][a-z0-9_]*(\[[a-z0-9_=",: ]*\])?$/;
const FN_REF = /^[a-z0-9_]+[:/][a-z0-9_/]+$/;
const SCORE_OPS = new Set(["<", "<=", "=", ">=", ">"]);
const SETBLOCK_MODE = new Set(["replace", "destroy", "keep"]);

function isInt(s: string | undefined): boolean {
  return s !== undefined && INT.test(s);
}

/** Validate one command line. Returns an error string, or null if valid. */
export function validateCommand(line: string): string | null {
  const raw = line.trim();
  if (raw === "" || raw.startsWith("#")) return null;

  // macro line: substitute $(...) placeholders then validate the concrete form
  if (raw.startsWith("$")) {
    const substituted = raw.slice(1).replace(/\$\([a-z0-9_]+\)/gi, "0");
    return validateCommand(substituted);
  }

  const t = raw.split(/\s+/);
  const head = t[0];
  switch (head) {
    case "setblock": {
      // setblock x y z block [mode]
      if (!isInt(t[1]) || !isInt(t[2]) || !isInt(t[3])) return `setblock coords not ints: ${raw}`;
      if (!t[4] || !BLOCK.test(t[4])) return `setblock bad block: ${raw}`;
      if (t[5] && !SETBLOCK_MODE.has(t[5])) return `setblock bad mode: ${raw}`;
      return null;
    }
    case "fill": {
      if (![1, 2, 3, 4, 5, 6].every((i) => isInt(t[i]))) return `fill coords not ints: ${raw}`;
      if (!t[7] || !BLOCK.test(t[7])) return `fill bad block: ${raw}`;
      return null;
    }
    case "function": {
      if (!t[1] || !FN_REF.test(t[1])) return `function bad ref: ${raw}`;
      // optional: function <ref> with storage <ns:path>
      if (t[2] && !(t[2] === "with" && t[3] === "storage" && t[4] && FN_REF.test(t[4])))
        return `function bad 'with' clause: ${raw}`;
      return null;
    }
    case "forceload": {
      if (t[1] !== "add" || ![2, 3, 4, 5].every((i) => isInt(t[i]))) return `forceload bad: ${raw}`;
      return null;
    }
    case "tickingarea": {
      if (t[1] !== "add" || ![2, 3, 4, 5, 6, 7].every((i) => isInt(t[i]))) return `tickingarea bad: ${raw}`;
      return null; // trailing name token optional/allowed
    }
    case "return":
      return isInt(t[1]) ? null : `return needs int: ${raw}`;
    case "scoreboard":
      return validateScoreboard(t, raw);
    case "execute":
      return validateExecute(raw);
    default:
      return `unknown command head '${head}': ${raw}`;
  }
}

function validateScoreboard(t: string[], raw: string): string | null {
  if (t[1] === "objectives") {
    if (t[2] === "add" && t[3] && t[4] === "dummy") return null;
    return `scoreboard objectives bad: ${raw}`;
  }
  if (t[1] === "players") {
    if ((t[2] === "set" || t[2] === "add" || t[2] === "remove") && t[3] && t[4] && isInt(t[5])) return null;
    if (t[2] === "get" && t[3] && t[4]) return null;
    return `scoreboard players bad: ${raw}`;
  }
  return `scoreboard bad: ${raw}`;
}

function validateExecute(raw: string): string | null {
  const runIdx = raw.indexOf(" run ");
  if (runIdx < 0) return `execute without run: ${raw}`;
  const clausePart = raw.slice("execute ".length, runIdx).trim();
  const sub = raw.slice(runIdx + 5).trim();
  const clauseErr = validateExecuteClauses(clausePart.split(/\s+/));
  if (clauseErr) return clauseErr;
  return validateCommand(sub); // recursive: the run target must itself be valid
}

function validateExecuteClauses(t: string[]): string | null {
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === "if" || c === "unless") {
      if (t[i + 1] !== "score") return `execute ${c} expects score`;
      // if score <t> <obj> (matches <range> | <op> <t2> <obj2>)
      const obj = t[i + 3];
      if (!t[i + 2] || !obj) return "execute score missing target/obj";
      if (t[i + 4] === "matches") {
        if (!t[i + 5] || !RANGE.test(t[i + 5]!)) return `execute matches bad range: ${t[i + 5]}`;
        i += 6;
      } else if (t[i + 4] && SCORE_OPS.has(t[i + 4]!)) {
        if (!t[i + 5] || !t[i + 6]) return "execute score op missing operands";
        i += 7;
      } else {
        return `execute score bad comparator: ${t[i + 4]}`;
      }
    } else if (c === "store") {
      // store result storage <ns:path> <field> <type> <int>
      if (t[i + 1] !== "result" || t[i + 2] !== "storage" || !t[i + 3] || !FN_REF.test(t[i + 3]!))
        return "execute store bad";
      if (!t[i + 4] || !t[i + 5] || !isInt(t[i + 6])) return "execute store bad tail";
      i += 7;
    } else {
      return `unknown execute clause '${c}'`;
    }
  }
  return null;
}

export interface ValidationResult {
  ok: boolean;
  errors: { file: string; line: number; command: string; error: string }[];
}

/** Validate every .mcfunction line across a generated pack's file map. */
export function validatePack(files: Map<string, string>): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  for (const [path, content] of files) {
    if (!path.endsWith(".mcfunction")) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const err = validateCommand(lines[i]!);
      if (err) errors.push({ file: path, line: i + 1, command: lines[i]!, error: err });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Pure reimplementation of the generated driver's scoreboard semantics - proves
 * the playback advances frames 0,1,…,N-1,0,1,… at the right cadence.
 */
export function simulateDriver(count: number, speed: number, ticks: number): number[] {
  let play = 1;
  let t = 0;
  let f = 0;
  const dispatched: number[] = [];
  for (let k = 0; k < ticks; k++) {
    if (play !== 1) continue;
    t += 1;
    if (t < speed) continue;
    t = 0;
    f += 1;
    if (f >= count) f = 0;
    dispatched.push(f);
  }
  return dispatched;
}
