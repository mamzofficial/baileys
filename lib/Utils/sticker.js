/**
 * lib/Utils/sticker.js — image/video -> WhatsApp WebP sticker conversion,
 * plus writing the sticker-pack EXIF metadata WhatsApp reads for the pack
 * name/publisher/emoji. Requires the optional "sharp" dependency; video
 * conversion additionally shells out to a locally-installed `ffmpeg`.
 *
 * Note on the ffmpeg call: options.fps/seconds are strictly validated and
 * coerced to bounded integers, and the process is spawned with an argv
 * array (execFile), never a shell string — so there's no way for a caller
 * (or attacker-controlled option) to inject extra shell commands here.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { Boom } from '@hapi/boom';

export const addExifToWebp = async (webpBuffer, { packName = '', packPublisher = '', categories = [] } = {}) => {
    const json = {
        'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
        'sticker-pack-name': packName,
        'sticker-pack-publisher': packPublisher,
        emojis: categories.length ? categories : ['😀']
    };
    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf-8');
    const exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16,
        0x00, 0x00, 0x00
    ]);
    exifAttr.writeUIntLE(jsonBuffer.length, 14, 4);
    const exifPayload = Buffer.concat([exifAttr, jsonBuffer]);
    const pad = (buf) => (buf.length % 2 === 1 ? Buffer.concat([buf, Buffer.from([0x00])]) : buf);
    const makeChunk = (tag, data) => {
        const sizeField = Buffer.alloc(4);
        sizeField.writeUInt32LE(data.length, 0);
        return Buffer.concat([Buffer.from(tag, 'ascii'), sizeField, pad(data)]);
    };
    const exifChunk = makeChunk('EXIF', exifPayload);
    if (webpBuffer.slice(0, 4).toString('ascii') !== 'RIFF' || webpBuffer.slice(8, 12).toString('ascii') !== 'WEBP') {
        throw new Error('addExifToWebp expects a valid WebP buffer');
    }
    let offset = 12;
    let vp8xChunk = null;
    const otherChunks = [];
    while (offset < webpBuffer.length) {
        const tag = webpBuffer.slice(offset, offset + 4).toString('ascii');
        const size = webpBuffer.readUInt32LE(offset + 4);
        const chunkTotal = 8 + size + (size % 2);
        if (tag === 'VP8X') {
            vp8xChunk = webpBuffer.slice(offset, offset + chunkTotal);
        }
        else if (tag !== 'EXIF') {
            otherChunks.push(webpBuffer.slice(offset, offset + chunkTotal));
        }
        offset += chunkTotal;
    }
    let flags;
    let canvasWidth;
    let canvasHeight;
    if (vp8xChunk) {
        flags = vp8xChunk.readUInt8(8);
        canvasWidth = vp8xChunk.readUIntLE(12, 3) + 1;
        canvasHeight = vp8xChunk.readUIntLE(15, 3) + 1;
    }
    else {
        flags = 0;
        let sharp;
        try {
            sharp = (await import('sharp')).default;
        }
        catch (error) {
            throw new Error('addExifToWebp needs the optional "sharp" dependency to read image dimensions');
        }
        const meta = await sharp(webpBuffer).metadata();
        canvasWidth = meta.width;
        canvasHeight = meta.height;
    }
    flags |= 0x08;
    const vp8xData = Buffer.alloc(10);
    vp8xData.writeUInt8(flags, 0);
    vp8xData.writeUIntLE(canvasWidth - 1, 4, 3);
    vp8xData.writeUIntLE(canvasHeight - 1, 7, 3);
    const newVp8xChunk = makeChunk('VP8X', vp8xData);
    const body = Buffer.concat([newVp8xChunk, ...otherChunks, exifChunk]);
    const fileSize = Buffer.alloc(4);
    fileSize.writeUInt32LE(4 + body.length, 0);
    return Buffer.concat([Buffer.from('RIFF', 'ascii'), fileSize, Buffer.from('WEBP', 'ascii'), body]);
};

export const imageToWebpSticker = async (imageBuffer, options = {}) => {
    let sharp;
    try {
        sharp = (await import('sharp')).default;
    }
    catch (error) {
        throw new Error('imageToWebpSticker requires the optional "sharp" dependency to be installed');
    }
    const webp = await sharp(imageBuffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: options.quality ?? 80 })
        .toBuffer();
    return addExifToWebp(webp, options);
};

/** Clamp a user-supplied numeric option to a safe integer range, with a default if invalid. */
const boundedInt = (value, { min, max, fallback }) => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
};

export const videoToWebpSticker = async (videoBuffer, options = {}) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mamzhandsome-baileys-sticker-'));
    const inputPath = path.join(tmpDir, 'input.mp4');
    const outputPath = path.join(tmpDir, 'output.webp');
    fs.writeFileSync(inputPath, videoBuffer);
    // Validated/clamped, not interpolated into a shell string — see execFile call below.
    const fps = boundedInt(options.fps, { min: 1, max: 30, fallback: 10 });
    const seconds = boundedInt(options.seconds, { min: 1, max: 10, fallback: 5 });
    const vf = `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease,` +
        `pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,split[a][b];` +
        `[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse`;
    const args = ['-y', '-i', inputPath, '-t', String(seconds), '-vf', vf, '-loop', '0', '-preset', 'default', '-an', '-vsync', '0', outputPath];
    try {
        await new Promise((resolve, reject) => {
            // execFile with an argv array — ffmpeg is invoked directly, no shell is
            // spawned, so nothing in `args` (all of which are numbers/paths we built
            // ourselves) can be interpreted as a shell command.
            execFile('ffmpeg', args, (err) => (err ? reject(err) : resolve()));
        });
        const webp = fs.readFileSync(outputPath);
        return await addExifToWebp(webp, options);
    }
    finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
};

// --- Added from baileys@6.2.7: a second, independent sticker-conversion path.
// Unlike imageToWebpSticker/videoToWebpSticker above (which need the optional
// "sharp" dependency and write video input/output to temp files), everything
// below goes straight through `ffmpeg` via piped stdin/stdout — no temp files,
// no "sharp" dependency, and it auto-detects image vs. video input. `spawn()`
// is called with an argv array (no `shell: true`), same "no shell involved"
// safety property as the execFile call above. Kept as separate exports (no
// name overlap with addExifToWebp/imageToWebpSticker/videoToWebpSticker) so
// both paths remain available — use whichever fits: the sharp-based path if
// you already depend on sharp elsewhere, this one if you'd rather not.

const runFfmpeg = (input, args) => new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...args, 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const outChunks = [];
    const errChunks = [];
    proc.stdout.on('data', chunk => outChunks.push(chunk));
    proc.stderr.on('data', chunk => errChunks.push(chunk));
    proc.on('error', err => reject(new Boom(`ffmpeg failed to start: ${err.message}`, { statusCode: 500 })));
    proc.on('close', code => {
        if (code !== 0) {
            reject(new Boom(`ffmpeg exited with code ${code}: ${Buffer.concat(errChunks).toString('utf8').slice(0, 500)}`, { statusCode: 500 }));
            return;
        }
        resolve(Buffer.concat(outChunks));
    });
    proc.stdin.on('error', () => { });
    proc.stdin.end(input);
});

/** Best-effort sniff of whether `buffer` looks like a video (vs. a still image), by container magic bytes. */
export const isLikelyVideoBuffer = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return false;
    }
    const header = buffer.subarray(0, 16).toString('ascii');
    if (header.startsWith('RIFF') && /AVI|WEBM/.test(header)) {
        return true;
    }
    if (buffer.subarray(0, 4).toString('hex') === '1a45dfa3') {
        return true;
    }
    const ftyp = buffer.toString('ascii', 4, 12);
    if (buffer.toString('ascii', 0, 4) === 'ftyp' || /^(ftyp)/.test(buffer.toString('ascii', 0, 8))) {
        return /mp4|isom|M4V|M4A|qt\s/.test(ftyp);
    }
    return false;
};

/** Image or video Buffer -> 512x512 WebP Buffer (no EXIF yet), entirely via piped ffmpeg. */
export const convertToWebp = async (buffer, { animated = false, quality = 60 } = {}) => {
    const scalePad = "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,format=rgba,pad=512:512:-1:-1:color=#00000000";
    const args = animated
        ? ['-vf', `${scalePad},fps=15`, '-loop', '0', '-preset', 'default', '-an', '-vsync', '0', '-vcodec', 'libwebp', '-q:v', String(quality), '-f', 'webp']
        : ['-vf', `${scalePad}`, '-vframes', '1', '-vcodec', 'libwebp', '-q:v', String(quality), '-f', 'webp'];
    return runFfmpeg(buffer, args);
};

/** Image or video Buffer -> 96x96 PNG Buffer, for a sticker pack's tray icon. */
export const convertToTrayIcon = async (buffer) => {
    const scalePad = "scale='min(96,iw)':'min(96,ih)':force_original_aspect_ratio=decrease,format=rgba,pad=96:96:-1:-1:color=#00000000";
    const args = ['-vf', scalePad, '-vframes', '1', '-vcodec', 'png', '-f', 'image2'];
    return runFfmpeg(buffer, args);
};

const readWebpChunks = (buf) => {
    const chunks = [];
    let offset = 12;
    while (offset + 8 <= buf.length) {
        const fourCC = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        const dataStart = offset + 8;
        const data = buf.subarray(dataStart, dataStart + size);
        chunks.push({ fourCC, data });
        offset = dataStart + size + (size % 2);
    }
    return chunks;
};
const buildWebpChunk = (fourCC, data) => {
    const header = Buffer.alloc(8);
    header.write(fourCC, 0, 4, 'ascii');
    header.writeUInt32LE(data.length, 4);
    const pad = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([header, data, pad]);
};
const buildExifChunkData = (json) => {
    const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const payload = Buffer.from(JSON.stringify(json), 'utf8');
    header.writeUInt32LE(payload.length, 14);
    return Buffer.concat([header, payload]);
};

/**
 * Writes WhatsApp's sticker-pack EXIF metadata into a WebP buffer.
 * Same job as addExifToWebp() above, independent implementation (adds an
 * `is-avatar-sticker` field and reads canvas dimensions from the VP8/VP8L
 * frame instead of falling back to `sharp` when there's no VP8X chunk).
 */
export const writeExifToWebp = (webpBuffer, { packId, packName = '', publisher = '', emojis = [], isAvatar = false } = {}) => {
    if (webpBuffer.toString('ascii', 0, 4) !== 'RIFF' || webpBuffer.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Boom('writeExifToWebp: not a valid webp buffer', { statusCode: 400 });
    }
    const chunks = readWebpChunks(webpBuffer);
    const exifData = buildExifChunkData({
        'sticker-pack-id': packId || crypto.randomUUID(),
        'sticker-pack-name': packName,
        'sticker-pack-publisher': publisher,
        emojis: emojis.length ? emojis : ['🤖'],
        'is-avatar-sticker': isAvatar ? 1 : 0
    });
    let vp8x = chunks.find(c => c.fourCC === 'VP8X');
    const otherChunks = chunks.filter(c => c.fourCC !== 'VP8X' && c.fourCC !== 'EXIF');
    if (!vp8x) {
        const img = otherChunks.find(c => c.fourCC === 'VP8 ' || c.fourCC === 'VP8L');
        if (!img) {
            throw new Boom('writeExifToWebp: no VP8/VP8L image data found', { statusCode: 400 });
        }
        let width;
        let height;
        if (img.fourCC === 'VP8 ') {
            width = (img.data.readUInt16LE(6) & 0x3fff);
            height = (img.data.readUInt16LE(8) & 0x3fff);
        }
        else {
            const b = img.data;
            width = 1 + (((b[2] & 0x3f) << 8) | b[1]);
            height = 1 + (((b[4] & 0xf) << 10) | (b[3] << 2) | ((b[2] & 0xc0) >> 6));
        }
        const flags = Buffer.alloc(4);
        flags[0] = 0x08;
        const dims = Buffer.alloc(6);
        dims.writeUIntLE(width - 1, 0, 3);
        dims.writeUIntLE(height - 1, 3, 3);
        vp8x = { fourCC: 'VP8X', data: Buffer.concat([flags, dims]) };
    }
    else {
        const flagsByte = vp8x.data[0] | 0x08;
        vp8x = { fourCC: 'VP8X', data: Buffer.concat([Buffer.from([flagsByte]), vp8x.data.subarray(1)]) };
    }
    const rebuilt = [vp8x, ...otherChunks, { fourCC: 'EXIF', data: exifData }];
    const chunkBuffers = rebuilt.map(c => buildWebpChunk(c.fourCC, c.data));
    const payload = Buffer.concat(chunkBuffers);
    const riffSize = 4 + payload.length;
    const out = Buffer.alloc(8 + 4 + payload.length);
    out.write('RIFF', 0, 4, 'ascii');
    out.writeUInt32LE(riffSize, 4);
    out.write('WEBP', 8, 4, 'ascii');
    payload.copy(out, 12);
    return out;
};

/** One-call image/video Buffer -> finished sticker WebP Buffer (auto-detects video, converts, writes EXIF). */
export const makeSticker = async (buffer, { pack = '', author = '', emojis = [], isPrivate = false, animated = false, quality = 60 } = {}) => {
    const shouldAnimate = animated || isLikelyVideoBuffer(buffer);
    const webp = await convertToWebp(buffer, { animated: shouldAnimate, quality });
    return writeExifToWebp(webp, { packName: pack, publisher: author, emojis, isAvatar: isPrivate });
};
