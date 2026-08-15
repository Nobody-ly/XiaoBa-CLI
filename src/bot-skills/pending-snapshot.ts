import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface BotSkillPendingSnapshotOptions {
  runtimeRoot: string;
  botId: string;
  sourcePath: string;
  recordedSourcePath?: string;
  reason:
    | 'activation_local_changed'
    | 'activation_without_base'
    | 'activation_cloud_reconcile';
  baseRevision?: number;
  cloudRevision: number;
  now?: () => Date;
}

export interface BotSkillPendingSnapshotResult {
  path: string;
  fingerprint: string;
  fileCount: number;
  deduplicated: boolean;
}

interface PendingSnapshotFile {
  path: string;
  size: number;
  sha256: string;
}

interface PendingSnapshotManifest {
  schema: 'xiaoba.bot-skill-local-pending.v1';
  botId: string;
  sourcePath: string;
  reason: BotSkillPendingSnapshotOptions['reason'];
  detectedAt: string;
  fingerprint: string;
  cloudRevision: number;
  baseRevision?: number;
  files: PendingSnapshotFile[];
}

/**
 * Preserves a complete local Skill workspace before Cloud-authoritative
 * activation replaces it. The snapshot is evidence only and is never loaded
 * as an active Skill workspace.
 */
export function snapshotPendingBotSkillWorkspace(
  options: BotSkillPendingSnapshotOptions,
): BotSkillPendingSnapshotResult {
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const sourcePath = path.resolve(options.sourcePath);
  const recordedSourcePath = path.resolve(options.recordedSourcePath ?? sourcePath);
  const botId = normalizeBotId(options.botId);
  const files = listWorkspaceFiles(sourcePath);
  const fingerprint = pendingFingerprint({
    botId,
    sourcePath: recordedSourcePath,
    reason: options.reason,
    ...(options.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
    cloudRevision: options.cloudRevision,
    files,
  });
  const root = path.join(runtimeRoot, 'data', 'bot-skills', 'local-pending', botId);
  const existing = findExistingSnapshot(root, fingerprint);
  if (existing) return { path: existing, fingerprint, fileCount: files.length, deduplicated: true };

  const detectedAt = (options.now ?? (() => new Date()))().toISOString();
  const directoryName = `${detectedAt.replace(/[:.]/g, '-')}-${fingerprint}`;
  const finalPath = path.join(root, directoryName);
  const temporary = path.join(root, `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const packageRoot = path.join(temporary, 'package');
  const manifest: PendingSnapshotManifest = {
    schema: 'xiaoba.bot-skill-local-pending.v1',
    botId,
    sourcePath: recordedSourcePath,
    reason: options.reason,
    detectedAt,
    fingerprint,
    cloudRevision: options.cloudRevision,
    ...(options.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
    files,
  };

  fs.mkdirSync(packageRoot, { recursive: true });
  try {
    for (const file of files) {
      const source = path.join(sourcePath, ...file.path.split('/'));
      const target = path.join(packageRoot, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      const copied = fileRecord(packageRoot, file.path);
      if (copied.size !== file.size || copied.sha256 !== file.sha256) {
        throw new Error(`Bot Skill pending snapshot verification failed: ${file.path}`);
      }
    }
    fs.writeFileSync(
      path.join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    fs.mkdirSync(root, { recursive: true });
    fs.renameSync(temporary, finalPath);
    return { path: finalPath, fingerprint, fileCount: files.length, deduplicated: false };
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function listWorkspaceFiles(root: string): PendingSnapshotFile[] {
  if (!fs.existsSync(root)) return [];
  const rootStats = fs.lstatSync(root);
  if (rootStats.isSymbolicLink()) {
    throw new Error('Bot Skill pending snapshot cannot follow a symbolic link at its root.');
  }
  if (!rootStats.isDirectory()) throw new Error('Bot Skill workspace is not a directory.');

  const files: PendingSnapshotFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        throw new Error(`Bot Skill pending snapshot cannot follow a symbolic link: ${relative}`);
      }
      if (stats.isDirectory()) visit(absolute);
      else if (stats.isFile()) files.push(fileRecord(root, relative));
      else throw new Error(`Bot Skill pending snapshot found an unsupported file: ${relative}`);
    }
  };
  visit(root);
  return files.sort((left, right) => compareText(left.path, right.path));
}

function fileRecord(root: string, relative: string): PendingSnapshotFile {
  const absolute = path.join(root, ...relative.split('/'));
  const bytes = fs.readFileSync(absolute);
  return { path: relative, size: bytes.length, sha256: sha256(bytes) };
}

function findExistingSnapshot(root: string, fingerprint: string): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) continue;
    const candidate = path.join(root, entry.name);
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(candidate, 'manifest.json'), 'utf8'),
      ) as Partial<PendingSnapshotManifest>;
      const packageFiles = listWorkspaceFiles(path.join(candidate, 'package'));
      if (
        manifest.schema === 'xiaoba.bot-skill-local-pending.v1'
        && manifest.fingerprint === fingerprint
        && Array.isArray(manifest.files)
        && snapshotFilesEqual(manifest.files, packageFiles)
        && pendingFingerprint({
          botId: String(manifest.botId || ''),
          sourcePath: String(manifest.sourcePath || ''),
          reason: manifest.reason as PendingSnapshotManifest['reason'],
          ...(manifest.baseRevision !== undefined ? { baseRevision: manifest.baseRevision } : {}),
          cloudRevision: Number(manifest.cloudRevision),
          files: packageFiles,
        }) === fingerprint
      ) return candidate;
    } catch {
      // Invalid old evidence must not suppress creation of a verified snapshot.
    }
  }
  return undefined;
}

function pendingFingerprint(
  value: Pick<
    PendingSnapshotManifest,
    'botId' | 'sourcePath' | 'reason' | 'baseRevision' | 'cloudRevision' | 'files'
  >,
): string {
  return sha256(Buffer.from(JSON.stringify({
    botId: value.botId,
    sourcePath: value.sourcePath,
    reason: value.reason,
    ...(value.baseRevision !== undefined ? { baseRevision: value.baseRevision } : {}),
    cloudRevision: value.cloudRevision,
    files: value.files,
  })));
}

function snapshotFilesEqual(
  expected: PendingSnapshotFile[],
  actual: PendingSnapshotFile[],
): boolean {
  return expected.length === actual.length && expected.every((file, index) => (
    file?.path === actual[index]?.path
    && file?.size === actual[index]?.size
    && file?.sha256 === actual[index]?.sha256
  ));
}

function normalizeBotId(value: string): string {
  const botId = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(botId)) {
    throw new Error('Invalid Bot ID for pending Skill evidence.');
  }
  return botId;
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
