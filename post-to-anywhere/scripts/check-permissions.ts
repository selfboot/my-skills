import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { findChromeExecutable, getDefaultProfileDir } from "./cdp.ts";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function log(label: string, ok: boolean, detail: string): void {
  results.push({ name: label, ok, detail });
  const icon = ok ? "OK" : "FAIL";
  console.log(`${icon} ${label}: ${detail}`);
}

function warn(label: string, detail: string): void {
  results.push({ name: label, ok: true, detail });
  console.log(`WARN ${label}: ${detail}`);
}

async function checkChrome(): Promise<void> {
  const chromePath = findChromeExecutable();
  if (chromePath) log("Chrome", true, chromePath);
  else log("Chrome", false, "Not found. Set POST_TO_ANYWHERE_BROWSER_CHROME_PATH or install Chrome.");
}

async function checkProfileDirs(): Promise<void> {
  const profiles = ["default", "wechat", "toutiao", "baijiahao", "zhihu"].map((name) => getDefaultProfileDir(name));
  for (const profileDir of profiles) {
    const label = `Profile dir ${path.basename(profileDir)}`;
    if (!fs.existsSync(profileDir)) {
      try {
        fs.mkdirSync(profileDir, { recursive: true });
        log(label, true, `Created ${profileDir}`);
      } catch (error) {
        log(label, false, `Cannot create ${profileDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    log(label, true, profileDir);
  }
}

async function checkBun(): Promise<void> {
  const result = spawnSync("npx", ["-y", "bun", "--version"], { stdio: "pipe", timeout: 30_000 });
  log("Bun runtime", result.status === 0, result.status === 0 ? `v${result.stdout?.toString().trim()}` : "Cannot run bun");
}

async function checkAccessibility(): Promise<void> {
  if (process.platform !== "darwin") {
    log("Accessibility", true, `Skipped on ${process.platform}`);
    return;
  }
  const result = spawnSync("osascript", ["-e", 'tell application "System Events" to return true'], {
    stdio: "pipe",
    timeout: 10_000,
  });
  log("Accessibility", result.status === 0, result.status === 0 ? "System Events available" : "Grant terminal app access in System Settings -> Privacy & Security -> Accessibility");
}

async function checkClipboardRead(): Promise<void> {
  if (process.platform === "darwin") {
    const result = spawnSync("pbpaste", [], { stdio: "pipe", timeout: 5_000 });
    log("Clipboard read", result.status === 0, result.status === 0 ? "pbpaste available" : "pbpaste unavailable");
    return;
  }
  log("Clipboard read", true, `Skipped on ${process.platform}`);
}

async function checkPasteKeystroke(): Promise<void> {
  if (process.platform === "darwin") {
    const result = spawnSync("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down'], {
      stdio: "pipe",
      timeout: 10_000,
    });
    log("Paste keystroke", result.status === 0, result.status === 0 ? "osascript available" : "Cannot send keystrokes");
    return;
  }

  if (process.platform === "linux") {
    const xdotool = spawnSync("which", ["xdotool"], { stdio: "pipe" });
    log("Paste keystroke", xdotool.status === 0, xdotool.status === 0 ? "xdotool available" : "Install xdotool or ydotool");
    return;
  }

  log("Paste keystroke", true, "Windows uses built-in key events");
}

async function checkRunningChromeConflict(): Promise<void> {
  if (process.platform !== "darwin") return;
  const result = spawnSync("pgrep", ["-f", "Google Chrome"], { stdio: "pipe" });
  const pids = result.stdout?.toString().trim().split("\n").filter(Boolean) || [];
  if (pids.length > 0) warn("Running Chrome instances", `${pids.length} Chrome process(es) detected; isolated profiles keep this safe`);
  else log("Running Chrome instances", true, "No existing Chrome processes");
}

async function main(): Promise<void> {
  console.log("=== post-to-anywhere: Permission & Environment Check ===\n");
  await checkChrome();
  await checkProfileDirs();
  await checkBun();
  await checkAccessibility();
  await checkClipboardRead();
  await checkPasteKeystroke();
  await checkRunningChromeConflict();

  console.log("\n--- Summary ---");
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    console.log("All checks passed. Ready to publish.");
  } else {
    console.log(`${failed.length} issue(s) found:`);
    for (const failure of failed) {
      console.log(`  FAIL ${failure.name}: ${failure.detail}`);
    }
    process.exit(1);
  }
}

await main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
