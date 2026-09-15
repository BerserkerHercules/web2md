import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

export interface ArchiveResult {
  markdownPath: string;
  zipPath: string;
  markdownName: string;
  zipName: string;
  zipSize: number;
}

/**
 * 将 Markdown 与 images/ 目录打包为 ZIP。
 * 目录结构：<title>.md + images/*
 */
export function writeArtifacts(
  jobDir: string,
  markdownName: string,
  markdown: string,
): ArchiveResult {
  const mdName = markdownName.endsWith('.md') ? markdownName : `${markdownName}.md`;
  const zipName = mdName.replace(/\.md$/, '.zip');
  const markdownPath = join(jobDir, mdName);
  const zipPath = join(jobDir, zipName);

  writeFileSync(markdownPath, markdown, 'utf-8');

  const zip = new AdmZip();
  zip.addFile(mdName, Buffer.from(markdown, 'utf-8'));

  const imagesDir = join(jobDir, 'images');
  if (existsSync(imagesDir) && statSync(imagesDir).isDirectory()) {
    for (const file of readdirSync(imagesDir)) {
      const full = join(imagesDir, file);
      if (statSync(full).isFile()) {
        zip.addLocalFile(full, 'images');
      }
    }
  }
  zip.writeZip(zipPath);

  return {
    markdownPath,
    zipPath,
    markdownName: mdName,
    zipName,
    zipSize: statSync(zipPath).size,
  };
}
