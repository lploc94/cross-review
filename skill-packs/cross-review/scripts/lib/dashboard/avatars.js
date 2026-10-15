// Avatars the user uploads, one image per party: `you`, `reviewer:<name>`,
// `agent:<client name>`. Stored in ~/.cross-review/avatars/ as <key with ":" → "-">.<ext>.
// Only PNG, JPEG, WebP and GIF, recognised by their first bytes, up to 1 MB; never SVG.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AVATAR_MAX_BYTES = 1024 * 1024;
export const AVATAR_KEY_RE = /^(you|reviewer:[a-z0-9-]+|agent:[a-z0-9._-]+)$/;
const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export class AvatarError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const avatarsDir = () => path.join(os.homedir(), ".cross-review", "avatars");

/** The image type from the file's first bytes, or null. */
export function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

const base = key => key.replace(":", "-");
const keyOf = name => {
  const stem = name.replace(/\.[a-z]+$/, "");
  if (stem === "you") return "you";
  const i = stem.indexOf("-");
  return i > 0 ? `${stem.slice(0, i)}:${stem.slice(i + 1)}` : null;
};

function checkKey(key) {
  if (typeof key !== "string" || !AVATAR_KEY_RE.test(key)) throw new AvatarError("unknown avatar key", 400);
}

/** Keys that have an image. */
export function listAvatars(dir = avatarsDir()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter(n => /\.(png|jpg|webp|gif)$/.test(n)).map(keyOf).filter(k => k && AVATAR_KEY_RE.test(k)).sort();
}

/** { file, type } of the key's image, or null. */
export function avatarFile(key, dir = avatarsDir()) {
  if (typeof key !== "string" || !AVATAR_KEY_RE.test(key)) return null;
  for (const [ext, type] of Object.entries(TYPES)) {
    const file = path.join(dir, `${base(key)}.${ext}`);
    if (fs.existsSync(file)) return { file, type };
  }
  return null;
}

export function removeAvatar(key, dir = avatarsDir()) {
  checkKey(key);
  for (const ext of Object.keys(TYPES)) fs.rmSync(path.join(dir, `${base(key)}.${ext}`), { force: true });
}

/** Store `buf` as the key's image, replacing any earlier one. */
export function saveAvatar(key, buf, dir = avatarsDir()) {
  checkKey(key);
  if (buf.length > AVATAR_MAX_BYTES) throw new AvatarError("That image is over 1 MB. Pick a smaller one.", 413);
  const ext = sniff(buf);
  if (!ext) throw new AvatarError("Only PNG, JPEG, WebP or GIF images.", 400);
  fs.mkdirSync(dir, { recursive: true });
  removeAvatar(key, dir);
  const file = path.join(dir, `${base(key)}.${ext}`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return { key, type: TYPES[ext] };
}
