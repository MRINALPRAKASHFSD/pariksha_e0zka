import path from "node:path";
import { badRequest } from "./errors.js";

export interface AllowedFileFormat {
  extension: string;
  mimeTypes: readonly string[];
  canonicalMimeType: string;
}

export const ALLOWED_FILE_FORMATS: readonly AllowedFileFormat[] = [
  { extension: ".pdf", mimeTypes: ["application/pdf"], canonicalMimeType: "application/pdf" },
  {
    extension: ".docx",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
      "application/octet-stream",
    ],
    canonicalMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    extension: ".pptx",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
      "application/octet-stream",
    ],
    canonicalMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  {
    extension: ".xlsx",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
      "application/octet-stream",
    ],
    canonicalMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  { extension: ".txt", mimeTypes: ["text/plain"], canonicalMimeType: "text/plain" },
  { extension: ".png", mimeTypes: ["image/png"], canonicalMimeType: "image/png" },
  {
    extension: ".jpg",
    mimeTypes: ["image/jpeg", "image/pjpeg"],
    canonicalMimeType: "image/jpeg",
  },
  {
    extension: ".jpeg",
    mimeTypes: ["image/jpeg", "image/pjpeg"],
    canonicalMimeType: "image/jpeg",
  },
  { extension: ".webp", mimeTypes: ["image/webp"], canonicalMimeType: "image/webp" },
];

const DANGEROUS_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".vbs",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".html",
  ".htm",
  ".svg",
  ".php",
  ".py",
  ".rb",
  ".pl",
  ".jar",
  ".msi",
  ".dmg",
  ".app",
  ".com",
  ".scr",
  ".pif",
  ".docm",
  ".xlsm",
  ".pptm",
]);

/**
 * Strip path traversal components, control chars, and unsafe characters from user-provided filenames.
 */
export function sanitizeOriginalFilename(rawName: string): string {
  const baseName = path.posix.basename(rawName.replace(/\\/g, "/"));
  const noControl = Array.from(baseName)
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? "_" : ch))
    .join("");
  const cleaned = noControl
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();

  if (!cleaned) {
    return "attachment";
  }
  return cleaned.slice(0, 180);
}

function hasExecutableSignature(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  // PE/DOS MZ
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true;
  // ELF
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    return true;
  }
  // Shebang script (#!)
  if (buf[0] === 0x23 && buf[1] === 0x21) return true;
  // Mach-O / Java class magic bytes
  if (buf.length >= 4) {
    const magic = buf.readUInt32BE(0);
    if (
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcafebabe ||
      magic === 0xcffaedfe ||
      magic === 0xcefaedfe
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Inspect ZIP central directory entries to validate OOXML documents (.docx, .pptx, .xlsx)
 * and reject macros or embedded executable entries without decompressing untrusted payloads.
 */
function inspectOoxmlArchive(buffer: Buffer, ext: ".docx" | ".pptx" | ".xlsx"): void {
  if (
    buffer.length < 22 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    (buffer[2] !== 0x03 && buffer[2] !== 0x05)
  ) {
    throw badRequest(`Invalid archive signature for ${ext} document`, "INVALID_FILE_SIGNATURE");
  }

  // Locate End of Central Directory (PK\x05\x06) scanning backwards within max comment range
  const minOffset = Math.max(0, buffer.length - 65557);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw badRequest("Malformed OOXML archive structure", "INVALID_FILE_SIGNATURE");
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries === 0 || totalEntries > 5000 || centralDirOffset >= eocdOffset) {
    throw badRequest("Suspicious or empty OOXML archive structure", "INVALID_FILE_SIGNATURE");
  }

  const requiredDir = ext === ".docx" ? "word/" : ext === ".pptx" ? "ppt/" : "xl/";
  let hasContentTypes = false;
  let hasRequiredFolder = false;

  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (
      offset + 46 > eocdOffset ||
      buffer[offset] !== 0x50 ||
      buffer[offset + 1] !== 0x4b ||
      buffer[offset + 2] !== 0x01 ||
      buffer[offset + 3] !== 0x02
    ) {
      throw badRequest("Corrupted OOXML central directory", "INVALID_FILE_SIGNATURE");
    }

    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > eocdOffset) {
      throw badRequest("Invalid OOXML archive entry header", "INVALID_FILE_SIGNATURE");
    }

    const entryName = buffer.subarray(nameStart, nameEnd).toString("utf8");
    const lowerEntry = entryName.toLowerCase();

    if (lowerEntry.includes("..") || path.isAbsolute(entryName)) {
      throw badRequest("Archive contains unsafe path traversal entry", "DANGEROUS_FILE_CONTENT");
    }
    if (lowerEntry.endsWith("vbaproject.bin")) {
      throw badRequest("Macro-enabled Office files are not permitted", "DANGEROUS_FILE_CONTENT");
    }
    const entryExt = path.posix.extname(lowerEntry);
    if (DANGEROUS_EXTENSIONS.has(entryExt)) {
      throw badRequest(
        `Archive contains disallowed executable or script entry (${entryExt})`,
        "DANGEROUS_FILE_CONTENT",
      );
    }

    if (entryName === "[Content_Types].xml") {
      hasContentTypes = true;
    }
    if (entryName.startsWith(requiredDir)) {
      hasRequiredFolder = true;
    }

    offset = nameEnd + extraLen + commentLen;
  }

  if (!hasContentTypes || !hasRequiredFolder) {
    throw badRequest(
      `File contents do not match expected ${ext.toUpperCase()} document structure`,
      "INVALID_FILE_SIGNATURE",
    );
  }
}

export interface ValidatedUploadFile {
  originalName: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
}

export function validateUploadedFile(file: {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}): ValidatedUploadFile {
  if (!file.buffer || file.size === 0) {
    throw badRequest("Empty files are not permitted", "EMPTY_FILE");
  }

  const sanitizedName = sanitizeOriginalFilename(file.originalname);
  const ext = path.posix.extname(sanitizedName).toLowerCase();

  if (!ext || DANGEROUS_EXTENSIONS.has(ext)) {
    throw badRequest(
      `File type "${ext || "unknown"}" is not allowed`,
      "DISALLOWED_FILE_TYPE",
    );
  }

  const format = ALLOWED_FILE_FORMATS.find((f) => f.extension === ext);
  if (!format) {
    throw badRequest(`Unsupported file extension "${ext}"`, "DISALLOWED_FILE_TYPE");
  }

  const normalizedMime = file.mimetype.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!format.mimeTypes.includes(normalizedMime)) {
    throw badRequest(
      `MIME type "${normalizedMime}" does not match extension "${ext}"`,
      "INVALID_MIME_TYPE",
    );
  }

  const buf = file.buffer;
  if (hasExecutableSignature(buf)) {
    throw badRequest("Executable binary content is strictly prohibited", "DANGEROUS_FILE_CONTENT");
  }

  switch (ext) {
    case ".pdf": {
      if (buf.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw badRequest("Invalid PDF file signature", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
    case ".png": {
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (buf.length < 8 || !buf.subarray(0, 8).equals(pngMagic)) {
        throw badRequest("Invalid PNG file signature", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
    case ".jpg":
    case ".jpeg": {
      if (buf.length < 3 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
        throw badRequest("Invalid JPEG file signature", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
    case ".webp": {
      if (
        buf.length < 12 ||
        buf.subarray(0, 4).toString("ascii") !== "RIFF" ||
        buf.subarray(8, 12).toString("ascii") !== "WEBP"
      ) {
        throw badRequest("Invalid WebP file signature", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
    case ".txt": {
      if (buf.includes(0x00)) {
        throw badRequest("Binary data is not allowed in text files", "INVALID_FILE_SIGNATURE");
      }
      const preview = buf.subarray(0, Math.min(buf.length, 4096)).toString("utf8").toLowerCase();
      if (
        preview.includes("<script") ||
        preview.includes("<!doctype html") ||
        preview.includes("<html") ||
        preview.includes("<svg")
      ) {
        throw badRequest("Active HTML/SVG markup is not allowed in text uploads", "DANGEROUS_FILE_CONTENT");
      }
      break;
    }
    case ".docx":
    case ".pptx":
    case ".xlsx": {
      inspectOoxmlArchive(buf, ext);
      break;
    }
  }

  return {
    originalName: sanitizedName,
    extension: ext,
    mimeType: format.canonicalMimeType,
    sizeBytes: buf.length,
    buffer: buf,
  };
}
