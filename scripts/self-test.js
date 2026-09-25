#!/usr/bin/env node
/**
 * self-test.js — runs automatically right after `npm install` (via the
 * "postinstall" script in package.json). Checks, BEFORE you write a single
 * line of bot code:
 *   1. The package's own files loaded correctly (no broken install).
 *   2. This machine can actually open a WebSocket to WhatsApp's servers.
 *
 * Why: the single most common "why doesn't my bot work" report is a
 * hosting/network problem that has nothing to do with your bot code —
 * finding that out AFTER writing your whole bot is a waste of your time.
 * This catches it at install time instead, with a clear pass/fail printed
 * right in your terminal / panel console.
 *
 * This never fails the install itself (always exits 0) — a failing
 * connectivity check here doesn't mean your files are broken, and blocking
 * `npm install` over a transient network hiccup would be worse than useless
 * in CI/CD pipelines. It just makes sure you SEE the warning before you go
 * looking for bugs in the wrong place.
 *
 * Skip this entirely with: BAILEYS_SKIP_SELFTEST=1 npm install
 */
import chalk from 'chalk';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

const results = [];
const record = (name, pass, detail = '') => results.push({ name, pass, detail });

function banner() {
    console.log('');
    console.log(chalk.hex('#a855f7')('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.hex('#a855f7').bold('  @mamzhandsome/baileys — post-install self-test'));
    console.log(chalk.gray('  Checking your environment before you start building your bot.'));
    console.log(chalk.hex('#a855f7')('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
}

/** Check 1: did the package's own files load without throwing? */
async function testModuleIntegrity() {
    try {
        const mod = await import(path.join(packageRoot, 'lib', 'index.js'));
        const ok = typeof mod.default === 'function';
        record('Package installed correctly (makeWASocket loaded)', ok,
            ok ? '' : 'lib/index.js loaded, but makeWASocket is not a function — the install may be corrupted. Try a clean `npm install` again.');
    }
    catch (e) {
        record('Package installed correctly (makeWASocket loaded)', false,
            `Failed to import lib/index.js: ${e.message} — try removing node_modules and package-lock.json, then \`npm install\` again.`);
    }
}

/** Check 2: can this machine actually open a WebSocket to WhatsApp's servers? */
function testNetworkReachability() {
    return new Promise((resolve) => {
        const url = 'wss://web.whatsapp.com/ws/chat';
        const start = Date.now();
        let done = false;

        let ws;
        try {
            ws = new WebSocket(url, {
                origin: 'https://web.whatsapp.com',
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
        }
        catch (e) {
            record('This server can reach WhatsApp', false, `Failed to open a connection: ${e.message}`);
            resolve();
            return;
        }

        const finish = (pass, detail) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            record('This server can reach WhatsApp', pass, detail);
            try { ws.terminate(); } catch { }
            resolve();
        };

        const timer = setTimeout(() => {
            finish(false, `Timed out after ${Date.now() - start}ms — the socket never opened. ` +
                'This strongly suggests this network/host is blocking or throttling connections to ' +
                'WhatsApp, NOT a code problem. Try a different server/IP if this keeps happening.');
        }, 12000);

        ws.on('open', () => finish(true, `Succeeded in ${Date.now() - start}ms`));
        ws.on('error', (err) => finish(false, `${err.message} (after ${Date.now() - start}ms) — check your hosting's firewall/proxy.`));
        ws.on('unexpected-response', (req, res) => {
            finish(false, `Server responded, but it wasn't a WebSocket upgrade (HTTP ${res.statusCode}) — ` +
                'an ISP or hosting proxy/firewall is likely intercepting this connection.');
        });
    });
}

function printResults() {
    for (const r of results) {
        const icon = r.pass ? chalk.green('✅') : chalk.red('❌');
        console.log(`${icon} ${r.name}`);
        if (r.detail) console.log(chalk.gray(`   ${r.detail}`));
    }
    console.log('');

    const allPass = results.every(r => r.pass);
    if (allPass) {
        console.log(chalk.green.bold('  All checks passed. You\'re good to go — start building/running your bot.'));
    }
    else {
        console.log(chalk.yellow.bold('  ⚠  Something above failed.'));
        console.log(chalk.yellow('  This does NOT stop the install (so it won\'t break your CI/CD pipeline),'));
        console.log(chalk.yellow('  but if your bot later fails to connect or pair, check the point above'));
        console.log(chalk.yellow('  before you start debugging your code — it\'s the most likely cause.'));
    }
    console.log(chalk.hex('#a855f7')('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
}

(async () => {
    if (process.env.BAILEYS_SKIP_SELFTEST === '1') {
        console.log(chalk.gray('[@mamzhandsome/baileys] Self-test skipped (BAILEYS_SKIP_SELFTEST=1).'));
        process.exit(0);
    }

    banner();
    await testModuleIntegrity();
    await testNetworkReachability();
    printResults();

    // Always exit 0 — see the comment at the top of this file for why.
    process.exit(0);
})().catch((e) => {
    // Safety net: nothing that goes wrong in this TEST script itself should
    // ever fail the user's `npm install`.
    console.log(chalk.red(`[@mamzhandsome/baileys] Self-test error (ignored): ${e.message}`));
    process.exit(0);
});
