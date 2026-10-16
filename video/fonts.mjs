// The fonts every rendered picture and video of the dashboard is drawn with: SIL Open Font
// License 1.1 fonts pinned to one google/fonts commit, fetched by hash into video/.cache. The
// system fonts the dashboard asks for (Apple's among them) must not end up in a published image.
// Used by video/build.mjs and docs/screenshots.mjs.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".cache");
const FONT_COMMIT = "1d0e46c7933245c8180fe83e47917961c913bbdb";
const FONTS = [
  { family: "Promo Sans", path: "ofl/sourcesans3/SourceSans3[wght].ttf", sha256: "042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9" },
  { family: "Promo Serif", path: "ofl/sourceserif4/SourceSerif4[opsz,wght].ttf", sha256: "97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b" },
  { family: "Promo Mono", path: "ofl/jetbrainsmono/JetBrainsMono[wght].ttf", sha256: "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda" },
];
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

/** CSS with the fonts inlined, setting the dashboard's --sans, --serif and --mono to them. */
export async function oflFontCss() {
  fs.mkdirSync(CACHE, { recursive: true });
  const faces = [];
  for (const f of FONTS) {
    const file = path.join(CACHE, path.basename(f.path));
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== f.sha256) {
      const url = `https://raw.githubusercontent.com/google/fonts/${FONT_COMMIT}/${f.path.replace(/\[/g, "%5B").replace(/\]/g, "%5D")}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`font download failed (${res.status}): ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256(buf) !== f.sha256) throw new Error(`font hash mismatch: ${f.path}`);
      fs.writeFileSync(file, buf);
    }
    faces.push(`@font-face { font-family: "${f.family}"; src: url(data:font/ttf;base64,${fs.readFileSync(file).toString("base64")}) format("truetype"); font-weight: 200 900; }`);
  }
  faces.push(`:root { --sans: "Promo Sans", sans-serif !important; --serif: "Promo Serif", serif !important; --mono: "Promo Mono", monospace !important; }`);
  return faces.join("\n");
}

/**
 * Fails when any text on the page is drawn with a font other than the injected ones.
 * `call(method, params)` sends a DevTools Protocol command to the page.
 */
export async function checkFonts(call, label) {
  await call("DOM.enable");
  await call("CSS.enable");
  const { root } = await call("DOM.getDocument", { depth: -1 });
  const { nodeIds } = await call("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "*" });
  const system = new Set();
  for (const nodeId of nodeIds) {
    const { fonts } = await call("CSS.getPlatformFontsForNode", { nodeId });
    for (const f of fonts) if (!f.isCustomFont) system.add(f.familyName);
  }
  if (system.size) throw new Error(`${label}: text drawn with system fonts (${[...system].join(", ")}); only the OFL fonts may appear`);
}
