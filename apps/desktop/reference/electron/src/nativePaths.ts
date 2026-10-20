import {constants} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {link, lstat, mkdir, open, realpath, unlink} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {Sha256} from '@momoki/studio/reference/lib/sha256';
import {CHUNK, portableLength} from './contracts';

export function absent(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function aborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
}

export async function turn(): Promise<void> {
    await new Promise<void>(r => setTimeout(r, 0));
}

export async function reserveRoot(input: string): Promise<string> {
    if (!isAbsolute(input) || basename(input) === '.' || basename(input) === '..') throw new Error('请选择绝对新目录');
    const parent = await realpath(dirname(resolve(input)));
    const root = join(parent, basename(input));
    await mkdir(root, {recursive: false, mode: 0o700});
    return await existingRoot(root);
}

export async function existingRoot(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error('工作区路径必须为绝对目录');
    const normalized = resolve(input);
    const parent = await realpath(dirname(normalized));
    const candidate = join(parent, basename(normalized));
    const stat = await lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('工作区根目录必须为独立普通目录');
    const root = await realpath(candidate);
    if (root !== candidate) throw new Error('工作区目录存在链接');
    return root;
}

export async function ownedPath(root: string, path: string, kind: 'file' | 'dir', createParents = false, allowPair = false): Promise<string> {
    portableLength(path);
    const parts = path.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || /[\\:\u0000]/u.test(p))) throw new Error('管理文件路径无效');
    await existingRoot(root);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
        current = join(current, parts[i]);
        const last = i === parts.length - 1;
        if (createParents && !last) {
            try {
                await mkdir(current, {mode: 0o700});
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
            }
        }
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink() || (!(last && kind === 'file') && !stat.isDirectory()) || (last && kind === 'file' && (!stat.isFile() || stat.nlink !== (allowPair ? 2 : 1)))) throw new Error('管理路径包含链接或错误文件类型');
            const actual = await realpath(current);
            const rel = relative(root, actual);
            if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('管理路径越过工作区');
        } catch (error) {
            if (last && absent(error)) return current;
            throw error;
        }
    }
    return current;
}

export async function openOwned(root: string, path: string, writeNew = false): Promise<FileHandle> {
    const file = await ownedPath(root, path, 'file', writeNew);
    const handle = await open(file, (writeNew ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('管理文件必须是独立普通文件');
    } catch (error) {
        await handle.close();
        throw error;
    }
    return handle;
}

export async function flushDirectory(path: string): Promise<void> {
    const h = await open(path, constants.O_RDONLY);
    try {
        await h.sync();
    } finally {
        await h.close();
    }
}

export async function removeOwned(root: string, path: string): Promise<void> {
    const file = await ownedPath(root, path, 'file');
    try {
        await unlink(file);
        await flushDirectory(dirname(file));
    } catch (error) {
        if (!absent(error)) throw error;
    }
}

export async function publish(root: string, stage: string, target: string, afterLink?: () => Promise<void>): Promise<void> {
    const from = await ownedPath(root, stage, 'file');
    const to = await ownedPath(root, target, 'file', true);
    await link(from, to); // atomic no-overwrite publication; never link to the source
    await flushDirectory(dirname(to));
    await afterLink?.();
    await unlink(from);
    await flushDirectory(dirname(from));
    await ownedPath(root, target, 'file');
}

export async function writeAtomic(root: string, name: string, value: unknown): Promise<void> {
    const stage = `${name}.pending`;
    const handle = await openOwned(root, stage, true);
    try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
    } finally {
        await handle.close();
    }
    await publish(root, stage, name);
}

export async function readJson(root: string, name: string): Promise<unknown> {
    const h = await openOwned(root, name);
    try {
        if ((await h.stat()).size > 1024 * 1024) throw new Error('清单过大');
        return JSON.parse(await h.readFile('utf8')) as unknown;
    } finally {
        await h.close();
    }
}

export async function hashFile(root: string, path: string, signal?: AbortSignal): Promise<{
    size: number;
    hash: string
}> {
    const h = await openOwned(root, path);
    try {
        return await stream(h, undefined, signal);
    } finally {
        await h.close();
    }
}

export async function stream(source: FileHandle, destination?: FileHandle, signal?: AbortSignal, onChunk?: () => Promise<void>): Promise<{
    size: number;
    hash: string
}> {
    aborted(signal);
    const before = await source.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0) throw new Error('源文件为空或类型无效');
    const bytes = Buffer.alloc(Math.min(CHUNK, before.size));
    const hash = new Sha256();
    let position = 0;
    while (position < before.size) {
        aborted(signal);
        const length = Math.min(bytes.length, before.size - position);
        const {bytesRead} = await source.read(bytes, 0, length, position);
        aborted(signal);
        if (bytesRead !== length) throw new Error('源文件读取不完整');
        const chunk = bytes.subarray(0, length);
        hash.update(chunk);
        if (destination) {
            let written = 0;
            while (written < length) {
                const result = await destination.write(chunk, written, length - written, position + written);
                if (!result.bytesWritten) throw new Error('管理文件写入不完整');
                written += result.bytesWritten;
            }
        }
        position += length;
        await onChunk?.();
        await turn();
        aborted(signal);
    }
    const after = await source.stat();
    if (after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('源文件复制期间发生变化');
    if (destination) await destination.sync();
    return {size: position, hash: hash.digest()};
}

export async function copyOwned(fromRoot: string, path: string, toRoot: string, target: string, signal?: AbortSignal): Promise<{
    size: number;
    hash: string
}> {
    const source = await openOwned(fromRoot, path);
    try {
        const dest = await openOwned(toRoot, target, true);
        try {
            return await stream(source, dest, signal);
        } finally {
            await dest.close();
        }
    } finally {
        await source.close();
    }
}
