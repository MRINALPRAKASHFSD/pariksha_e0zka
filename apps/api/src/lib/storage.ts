import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { getEnv } from "../config/env.js";
import { badRequest } from "./errors.js";

export interface StoredFileMetadata {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

export interface FileStorageProvider {
  saveFile(
    buffer: Buffer,
    options: { folder: "assignments" | "submissions"; extension: string },
  ): Promise<StoredFileMetadata>;
  openReadStream(storageKey: string): Promise<fs.ReadStream>;
  deleteFile(storageKey: string): Promise<void>;
}

/**
 * Local disk storage provider enforcing root-directory containment.
 * Abstracted behind FileStorageProvider so private S3/GCS object storage
 * can replace disk persistence without altering academic workflows.
 */
export class LocalDiskStorageProvider implements FileStorageProvider {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  private resolveSafePath(storageKey: string): string {
    if (
      !storageKey ||
      storageKey.includes("\0") ||
      storageKey.includes("..") ||
      path.isAbsolute(storageKey)
    ) {
      throw badRequest("Invalid storage key", "INVALID_STORAGE_KEY");
    }

    const resolved = path.resolve(this.baseDir, storageKey);
    if (!resolved.startsWith(this.baseDir + path.sep)) {
      throw badRequest("Path traversal attempt rejected", "PATH_TRAVERSAL_BLOCKED");
    }
    return resolved;
  }

  async saveFile(
    buffer: Buffer,
    options: { folder: "assignments" | "submissions"; extension: string },
  ): Promise<StoredFileMetadata> {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const safeExt = options.extension.startsWith(".") ? options.extension : `.${options.extension}`;
    const storageKey = path.posix.join(options.folder, ym, `${crypto.randomUUID()}${safeExt}`);
    const targetPath = this.resolveSafePath(storageKey);

    await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o750 });
    await fsp.writeFile(targetPath, buffer, { mode: 0o640 });

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    return {
      storageKey,
      sizeBytes: buffer.length,
      sha256,
    };
  }

  async openReadStream(storageKey: string): Promise<fs.ReadStream> {
    const targetPath = this.resolveSafePath(storageKey);
    await fsp.access(targetPath, fs.constants.R_OK);
    return fs.createReadStream(targetPath);
  }

  async deleteFile(storageKey: string): Promise<void> {
    const targetPath = this.resolveSafePath(storageKey);
    await fsp.rm(targetPath, { force: true });
  }
}

export function getStorageProvider(): FileStorageProvider {
  const env = getEnv();
  return new LocalDiskStorageProvider(env.UPLOAD_DIR);
}

export function createAcademicUploadMiddleware() {
  const env = getEnv();
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: env.MAX_UPLOAD_SIZE_BYTES,
      files: env.MAX_UPLOAD_FILES,
      fields: 20,
    },
  });
}
