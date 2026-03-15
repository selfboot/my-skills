import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { findChromeExecutable, getDefaultProfileDir } from './cdp.ts';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function log(label: string, ok: boolean, detail: string): void {
  results.push({ name: label, ok, detail });
  const icon = ok ? 'OK' : 'FAIL';
  console.log(`${icon} ${label}: ${detail}`);
}

function warn(label: string, detail: string): void {
  results.push({ name: label, ok: true, detail });
  console.log(`WARN ${label}: ${detail}`);
}

async function checkChrome(): Promise<void> {
  const chromePath = findChromeExecutable();
  if (chromePath) {
    log('Chrome', true, chromePath);
  } else {
    log('Chrome', false, 'Not found. Set TOUTIAO_BROWSER_CHROME_PATH or install Chrome.');
  }
}

async function checkProfileIsolation(): Promise<void> {
  const profileDir = getDefaultProfileDir();
  const userChromeDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
    : process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
      : path.join(os.homedir(), '.config', 'google-chrome');

  const isIsolated = !profileDir.startsWith(userChromeDir);
  log('Profile isolation', isIsolated, `Skill profile: ${profileDir}`);

  if (!fs.existsSync(profileDir)) {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      log('Profile dir', true, 'Created successfully');
    } catch (error) {
      log('Profile dir', false, `Cannot create: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    log('Profile dir', true, 'Exists and accessible');
  }
}

async function checkAccessibility(): Promise<void> {
  if (process.platform !== 'darwin') {
    log('Accessibility', true, `Skipped (platform: ${process.platform})`);
    return;
  }

  const result = spawnSync('osascript', ['-e', 'tell application "System Events" to return true'], {
    stdio: 'pipe',
    timeout: 10_000,
  });

  if (result.status === 0) {
    log('Accessibility', true, 'System Events available');
  } else {
    log('Accessibility', false, 'Grant terminal app access in System Settings -> Privacy & Security -> Accessibility');
  }
}

async function checkClipboardCopy(): Promise<void> {
  if (process.platform !== 'darwin') {
    log('Clipboard copy', true, 'Skipped outside macOS');
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'toutiao-check-'));
  try {
    const testPng = path.join(tmpDir, 'test.png');
    const genScript = path.join(tmpDir, 'gen.swift');
    await writeFile(genScript, `import AppKit
import Foundation
let size = NSSize(width: 2, height: 2)
let image = NSImage(size: size)
image.lockFocus()
NSColor.red.set()
NSBezierPath.fill(NSRect(origin: .zero, size: size))
image.unlockFocus()
guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
  exit(1)
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
`, 'utf8');
    const genResult = spawnSync('swift', [genScript, testPng], { stdio: 'pipe', timeout: 30_000 });
    if (genResult.status !== 0) {
      log('Clipboard copy', false, 'Swift/AppKit unavailable');
      return;
    }
    log('Clipboard copy', true, 'Swift/AppKit available');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function checkPasteKeystroke(): Promise<void> {
  if (process.platform === 'darwin') {
    const result = spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], {
      stdio: 'pipe',
      timeout: 10_000,
    });
    log('Paste keystroke', result.status === 0, result.status === 0 ? 'osascript available' : 'Cannot send keystrokes');
    return;
  }

  if (process.platform === 'linux') {
    const xdotool = spawnSync('which', ['xdotool'], { stdio: 'pipe' });
    log('Paste keystroke', xdotool.status === 0, xdotool.status === 0 ? 'xdotool available' : 'Install xdotool or ydotool');
    return;
  }

  log('Paste keystroke', true, 'Windows uses built-in key events');
}

async function checkBun(): Promise<void> {
  const result = spawnSync('npx', ['-y', 'bun', '--version'], { stdio: 'pipe', timeout: 30_000 });
  log('Bun runtime', result.status === 0, result.status === 0 ? `v${result.stdout?.toString().trim()}` : 'Cannot run bun');
}

async function checkRunningChromeConflict(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const result = spawnSync('pgrep', ['-f', 'Google Chrome'], { stdio: 'pipe' });
  const pids = result.stdout?.toString().trim().split('\n').filter(Boolean) || [];
  if (pids.length > 0) {
    warn('Running Chrome instances', `${pids.length} Chrome process(es) detected; isolated profile keeps this safe`);
  } else {
    log('Running Chrome instances', true, 'No existing Chrome processes');
  }
}

async function main(): Promise<void> {
  console.log('=== selfboot-post-to-toutiao: Permission & Environment Check ===\n');
  await checkChrome();
  await checkProfileIsolation();
  await checkBun();
  await checkAccessibility();
  await checkClipboardCopy();
  await checkPasteKeystroke();
  await checkRunningChromeConflict();

  console.log('\n--- Summary ---');
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log('All checks passed. Ready to post to Toutiao.');
  } else {
    console.log(`${failed.length} issue(s) found:`);
    for (const failure of failed) {
      console.log(`  FAIL ${failure.name}: ${failure.detail}`);
    }
    process.exit(1);
  }
}

await main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
