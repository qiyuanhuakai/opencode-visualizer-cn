import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

function requiredPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return path.resolve(value.trim());
}

function isWithin(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveRoot(value) {
  return fs.realpath(requiredPath(value, 'File root'));
}

async function resolveReadablePath(filePath, rootPath) {
  const root = await resolveRoot(rootPath);
  const requested = requiredPath(filePath, 'File path');
  if (!isWithin(requested, root)) throw new Error('File path is outside the allowed root.');
  const resolved = await fs.realpath(requested);
  if (!isWithin(resolved, root)) throw new Error('File path is outside the allowed root.');
  return { root, requested, resolved };
}

async function resolveWritablePath(filePath, rootPath) {
  const root = await resolveRoot(rootPath);
  const requested = requiredPath(filePath, 'File path');
  if (!isWithin(requested, root)) throw new Error('File path is outside the allowed root.');
  const parent = await fs.realpath(path.dirname(requested));
  if (!isWithin(parent, root)) throw new Error('File path is outside the allowed root.');
  try {
    const stats = await fs.lstat(requested);
    if (stats.isSymbolicLink()) throw new Error('Writing through a symbolic link is not allowed.');
    const resolved = await fs.realpath(requested);
    if (!isWithin(resolved, root)) throw new Error('File path is outside the allowed root.');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  return { root, requested };
}

export function createWorkspaceFsManager() {
  return {
    async getCapabilities(rootPath) {
      const root = await resolveRoot(rootPath);
      const stats = await fs.stat(root);
      if (!stats.isDirectory()) throw new Error('FS root must be a directory.');
      await fs.access(root, constants.R_OK | constants.W_OK);
      return { root, writable: true };
    },
    async listDirectory(relativePath, rootPath) {
      const root = await resolveRoot(rootPath);
      const normalizedRelative = typeof relativePath === 'string' ? relativePath.trim() : '';
      const requested = path.resolve(root, normalizedRelative || '.');
      const { resolved } = await resolveReadablePath(requested, root);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const prefix =
        normalizedRelative && normalizedRelative !== '.'
          ? normalizedRelative.replace(/^\.\//u, '').replace(/\/$/u, '')
          : '';
      return entries.map((entry) => ({
        name: entry.name,
        path: prefix ? `${prefix}/${entry.name}` : entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      }));
    },
    async readFile(filePath, rootPath) {
      const { resolved } = await resolveReadablePath(filePath, rootPath);
      const content = await fs.readFile(resolved);
      return {
        path: resolved,
        content: content.toString('utf8'),
        dataBase64: content.toString('base64'),
        encoding: 'utf-8',
        type: 'text',
      };
    },
    async writeFile(filePath, rootPath, content) {
      const { requested } = await resolveWritablePath(filePath, rootPath);
      if (typeof content !== 'string') throw new Error('File content must be a string.');
      const handle = await fs.open(
        requested,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o666,
      );
      try {
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
      return { path: requested };
    },
  };
}
