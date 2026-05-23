import { Injectable } from '@nestjs/common';
import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

@Injectable()
export class FileIndexingService {
  indexFiles(
    rootPath: string,
    fileLimit?: number,
    _excludePatterns?: string[],
  ) {
    const files: string[] = [];
    const errors: string[] = [];
    const maxFiles = fileLimit || 10000;

    try {
      this.walkDir(rootPath, files, errors, maxFiles);
    } catch (err: any) {
      errors.push(err.message);
    }

    return {
      files,
      totalCount: files.length,
      errors,
    };
  }

  private walkDir(
    dir: string,
    files: string[],
    errors: string[],
    maxFiles: number,
  ) {
    if (files.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err: any) {
      errors.push(`Cannot read ${dir}: ${err.message}`);
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = join(dir, entry);

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          // Skip common non-source directories
          if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== '__pycache__') {
            this.walkDir(fullPath, files, errors, maxFiles);
          }
        } else if (this.isSourceFile(entry)) {
          files.push(fullPath);
        }
      } catch {
        // permission denied, skip
      }
    }
  }

  private isSourceFile(name: string): boolean {
    const ext = extname(name).toLowerCase();
    return ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh'].includes(ext);
  }
}
