/**
 * lib/Utils/native-bridge.js — best-effort loader for the optional
 * `whatsapp-rust-bridge` native addon. If it isn't installed (it's an
 * optional dependency), every function here just returns null instead of
 * throwing, so nothing breaks for people who don't need it.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const BRIDGE_NAME = 'whatsapp-rust-bridge';
let cached;
let attempted = false;

const findPackageDir = (pkgName) => {
    let searchPaths;
    try {
        searchPaths = require.resolve.paths(pkgName) || [];
    }
    catch {
        searchPaths = [];
    }
    for (const dir of searchPaths) {
        const candidate = path.join(dir, pkgName);
        if (fs.existsSync(path.join(candidate, 'package.json'))) {
            return candidate;
        }
    }
    return null;
};

export const loadRustBridge = () => {
    if (attempted) {
        return cached;
    }
    attempted = true;
    try {
        cached = require(BRIDGE_NAME);
        return cached;
    }
    catch (error) {
        const recoverableCodes = new Set(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_PACKAGE_IMPORT_NOT_DEFINED']);
        if (!recoverableCodes.has(error?.code)) {
            cached = null;
            return null;
        }
        try {
            const dir = findPackageDir(BRIDGE_NAME);
            if (!dir) {
                cached = null;
                return null;
            }
            const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
            const candidates = [
                pkgJson.main,
                'index.js',
                'index.node',
                'dist/index.js',
                'lib/index.js',
                'build/index.js'
            ].filter(Boolean);
            for (const rel of candidates) {
                const fullPath = path.join(dir, rel);
                if (fs.existsSync(fullPath)) {
                    cached = require(fullPath);
                    return cached;
                }
            }
        }
        catch {
            // fall through to returning null below
        }
        cached = null;
        return null;
    }
};
