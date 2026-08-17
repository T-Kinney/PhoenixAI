/**
 * Turning attached files into ACP prompt content.
 *
 * ACP carries a prompt as an array of content blocks, and an agent declares in
 * `initialize` which kinds it will accept:
 *
 *   promptCapabilities: { image, audio, embeddedContext }
 *
 * Grok Build (probed 2026-08-17, protocolVersion 1) reports:
 *
 *   image: false, audio: false, embeddedContext: true
 *
 * So it takes embedded text/resources but REFUSES image and audio blocks. That
 * is a property of the agent, not of us, and other harnesses answer differently
 * — which is why nothing here hardcodes Grok's answer. We ask the live agent and
 * degrade per file.
 *
 * The degradation for an unsupported binary is to stage the file on disk and
 * hand the agent a path, because every coding agent can read a file even when it
 * cannot receive bytes inline. That converts "unsupported" into "one tool call
 * away" instead of into a failure.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Inline text budget per file. Beyond this we stage and link instead. */
const MAX_INLINE_TEXT = 256 * 1024;
/** Total inline budget for one prompt, so ten files cannot blow the context. */
const MAX_INLINE_TOTAL = 768 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".log", ".csv", ".tsv",
  ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env-example",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".swift", ".m", ".mm", ".php", ".pl", ".lua",
  ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd", ".sql", ".r", ".jl", ".scala",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
  ".xml", ".svg", ".graphql", ".gql", ".proto", ".tf", ".hcl", ".dockerfile", ".gitignore",
  ".patch", ".diff", ".rhai"
]);

const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".avif": "image/avif", ".heic": "image/heic"
};

const AUDIO_MIME = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac", ".webm": "audio/webm"
};

export function classify(name) {
  const ext = path.extname(name || "").toLowerCase();
  if (IMAGE_MIME[ext]) return { kind: "image", mimeType: IMAGE_MIME[ext], ext };
  if (AUDIO_MIME[ext]) return { kind: "audio", mimeType: AUDIO_MIME[ext], ext };
  if (ext === ".pdf") return { kind: "pdf", mimeType: "application/pdf", ext };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "text", mimeType: guessTextMime(ext), ext };
  return { kind: "binary", mimeType: "application/octet-stream", ext };
}

function guessTextMime(ext) {
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".json" || ext === ".jsonl") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".svg") return "image/svg+xml";
  return "text/plain";
}

/**
 * A file whose bytes the agent will not accept is written here so it can be
 * opened with the agent's own tools. Staged under the app's data directory
 * rather than the user's project, because dropping files into someone's repo as
 * a side effect of attaching them would be its own bug.
 */
async function stage(stagingDir, name, buffer) {
  await fs.mkdir(stagingDir, { recursive: true });
  // Collision-proof without being unreadable: short hash + the original name.
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 8);
  const safe = path.basename(name).replace(/[^\w.@ -]/g, "_");
  const target = path.join(stagingDir, `${hash}-${safe}`);
  await fs.writeFile(target, buffer);
  return target;
}

function fileUri(absolute) {
  // ACP resource URIs are file:// URLs; Windows paths need the extra slash and
  // forward separators or the agent cannot resolve them.
  const normalized = absolute.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

function isProbablyText(buffer) {
  // A NUL in the first 8KB means binary; that check is cheap and near-perfect
  // for the files people actually attach.
  const window = buffer.subarray(0, 8192);
  return !window.includes(0);
}

/**
 * Build ACP content blocks for one prompt.
 *
 * @param {string} text  the user's message
 * @param {Array<{name: string, data: string, size?: number}>} attachments
 *        `data` is base64 of the file's bytes.
 * @param {object} options
 * @param {{image?: boolean, audio?: boolean, embeddedContext?: boolean}} options.capabilities
 * @param {string} options.stagingDir  where unsupported binaries are written
 * @returns {Promise<{blocks: Array, notes: Array<{name: string, how: string, detail?: string}>}>}
 */
export async function buildPromptBlocks(text, attachments = [], { capabilities = {}, stagingDir } = {}) {
  const blocks = [];
  const notes = [];
  const staged = [];
  let inlineBudget = MAX_INLINE_TOTAL;

  for (const attachment of attachments) {
    const name = attachment?.name ?? "attachment";
    let buffer;
    try {
      buffer = Buffer.from(attachment?.data ?? "", "base64");
    } catch {
      notes.push({ name, how: "skipped", detail: "could not decode" });
      continue;
    }
    if (!buffer.length) {
      notes.push({ name, how: "skipped", detail: "empty file" });
      continue;
    }

    const { kind, mimeType } = classify(name);

    // Images and audio: inline only if the agent said it accepts them.
    if (kind === "image" || kind === "audio") {
      const accepted = kind === "image" ? capabilities.image : capabilities.audio;
      if (accepted) {
        blocks.push({ type: kind, mimeType, data: buffer.toString("base64") });
        notes.push({ name, how: "inline" });
      } else {
        const at = await stage(stagingDir, name, buffer);
        staged.push({ name, at, kind });
        notes.push({ name, how: "staged", detail: `${kind} not accepted by this agent` });
      }
      continue;
    }

    // Text: embed if there is room and the agent takes embedded context.
    const textLike = kind === "text" || (kind === "binary" && isProbablyText(buffer));
    if (textLike && capabilities.embeddedContext !== false && buffer.length <= MAX_INLINE_TEXT
        && buffer.length <= inlineBudget) {
      const at = await stage(stagingDir, name, buffer);
      staged.push({ name, at, kind: "text", inlined: true });
      inlineBudget -= buffer.length;
      blocks.push({
        type: "resource",
        resource: { uri: fileUri(at), mimeType, text: buffer.toString("utf8") }
      });
      notes.push({ name, how: "inline" });
      continue;
    }

    // Everything else — PDFs, large text, real binaries — goes to disk and is
    // referenced. resource_link is the spec's pointer block; the path in the
    // text below is what actually makes it usable.
    const at = await stage(stagingDir, name, buffer);
    staged.push({ name, at, kind });
    blocks.push({
      type: "resource_link",
      uri: fileUri(at),
      name: path.basename(name),
      mimeType,
      size: buffer.length
    });
    notes.push({
      name,
      how: "staged",
      detail: buffer.length > MAX_INLINE_TEXT ? "too large to inline" : "binary"
    });
  }

  // Tell the agent, in words, where the staged files are. A resource_link alone
  // is easy for a model to ignore; an explicit instruction with absolute paths
  // is not.
  const needsPointer = staged.filter((s) => !s.inlined);
  let prompt = text ?? "";
  if (needsPointer.length) {
    const lines = needsPointer.map((s) => `- ${s.name} -> ${s.at}`).join("\n");
    prompt = `${prompt}\n\nAttached files, saved to disk. Read them with your own file tools:\n${lines}`;
  }

  // The text block leads, so the instruction is read before the payload.
  blocks.unshift({ type: "text", text: prompt });
  return { blocks, notes };
}
