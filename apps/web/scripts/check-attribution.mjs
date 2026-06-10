// Verify author attribution can't silently rot: every MPA page must credit Jack Lau and
// carry a meta author tag, and the landing page must deep-link the actual repository
// (github.com/jackulau/blockdream — not just the profile) including the corrected
// docs/load-into-minecraft.md blob link.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const PAGES = ["index.html", "blockart.html", "driving.html", "world-model.html"];
const REPO = "github.com/jackulau/blockdream";
const DOCS_LINK = `${REPO}/blob/master/docs/load-into-minecraft.md`;

const failures = [];

for (const page of PAGES) {
  const html = readFileSync(join(WEB, page), "utf8");
  if (!html.includes("Jack Lau")) failures.push(`${page}: missing author credit "Jack Lau"`);
  if (!html.includes('name="author"')) failures.push(`${page}: missing <meta name="author">`);
  if (!html.includes("og:title")) failures.push(`${page}: missing Open Graph tags`);
}

const index = readFileSync(join(WEB, "index.html"), "utf8");
if (!index.includes(REPO)) failures.push(`index.html: missing repository link ${REPO}`);
if (!index.includes(DOCS_LINK)) failures.push(`index.html: docs deep link must target ${DOCS_LINK}`);

if (failures.length > 0) {
  console.error("attribution check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`attribution ok: ${PAGES.length} pages credit Jack Lau, repo + docs links verified`);
