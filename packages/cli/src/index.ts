#!/usr/bin/env node
import { runCli } from "./cli";

export * from "./render";
export { runCli } from "./cli";

// run as a CLI when invoked directly (tsx/node entrypoint)
const invokedDirectly =
  process.argv[1] !== undefined && /\/cli\/src\/index\.ts$|\/mineworld$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
