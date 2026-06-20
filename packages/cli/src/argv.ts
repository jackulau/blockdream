// Shared CLI-argv helpers for both the offline render CLI (cli.ts) and the live sidecar (rcon-bridge-cli.ts).

/**
 * Rewrite `--flag -val` → `--flag=-val` for value-taking flags so a value that starts with `-` is not
 * mis-read as another option. node's `parseArgs` otherwise throws "Option '--origin' argument is
 * ambiguous" on a negative `--origin` like `-50,70,-50` (common Minecraft coords). `booleanFlags` (the
 * caller's no-value flags) are left untouched. Pure - run it on argv before parsing.
 */
export function joinDashValues(args: string[], booleanFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^--([a-z][a-z-]*)$/.exec(a);
    const next = args[i + 1];
    if (m && !booleanFlags.has(m[1]!) && next !== undefined && next.startsWith("-") && !next.startsWith("--")) {
      out.push(`${a}=${next}`);
      i++;
    } else {
      out.push(a);
    }
  }
  return out;
}
