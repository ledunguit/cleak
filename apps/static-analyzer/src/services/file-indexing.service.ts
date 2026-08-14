import { Injectable, Logger } from '@nestjs/common';
import { readdirSync, lstatSync, realpathSync } from 'fs';
import { join, extname, sep } from 'path';
import { ServerEventName } from '@cleak/common/mcp/server-events';

@Injectable()
export class FileIndexingService {
  private readonly logger = new Logger(FileIndexingService.name);

  indexFiles(
    rootPath: string,
    fileLimit?: number,
    _excludePatterns?: string[],
  ) {
    const files: string[] = [];
    const errors: string[] = [];
    const maxFiles = fileLimit || 10000;
    this.logger.log({ event: ServerEventName.INDEX_STARTED, rootPath, fileLimit: maxFiles }, 'index started');

    // Canonical root: every indexed path must stay inside it, so a symlink planted
    // in the scanned repo can't redirect indexing to /etc, ~/.ssh, etc.
    let root: string;
    try {
      root = realpathSync(rootPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ event: ServerEventName.INDEX_FINISHED, rootPath, err: msg }, 'index failed to resolve root');
      return { files, totalCount: 0, errors: [`Cannot resolve root ${rootPath}: ${msg}`] };
    }

    try {
      this.walkDir(root, root, files, errors, maxFiles);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
    }

    this.logger.log({ event: ServerEventName.INDEX_FINISHED, rootPath, fileCount: files.length, errorCount: errors.length }, 'index finished');
    return {
      files,
      totalCount: files.length,
      errors,
    };
  }

  /** True iff `resolved` is the root itself or strictly inside it. */
  private within(root: string, resolved: string): boolean {
    return resolved === root || resolved.startsWith(root + sep);
  }

  private walkDir(
    root: string,
    dir: string,
    files: string[],
    errors: string[],
    maxFiles: number,
  ) {
    if (files.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Cannot read ${dir}: ${msg}`);
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = join(dir, entry);

      try {
        // lstat (not stat) so we SEE symlinks instead of following them blindly.
        const lst = lstatSync(fullPath);
        if (lst.isSymbolicLink()) {
          // Follow a symlink only if its real target stays within the repo root.
          const real = realpathSync(fullPath);
          if (!this.within(root, real)) continue;
          const target = lstatSync(real);
          if (target.isDirectory()) {
            if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== '__pycache__') {
              this.walkDir(root, real, files, errors, maxFiles);
            }
          } else if (target.isFile() && this.isSourceFile(entry)) {
            files.push(fullPath);
          }
          continue;
        }
        if (lst.isDirectory()) {
          // Skip common non-source directories
          if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== '__pycache__') {
            this.walkDir(root, fullPath, files, errors, maxFiles);
          }
        } else if (this.isSourceFile(entry)) {
          files.push(fullPath);
        }
      } catch {
        // permission denied, broken symlink, etc. — skip
      }
    }
  }

  private isSourceFile(name: string): boolean {
    const ext = extname(name).toLowerCase();
    return ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh'].includes(ext);
  }
}
