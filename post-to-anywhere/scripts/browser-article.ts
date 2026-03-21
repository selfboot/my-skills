import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  launchChrome,
  tryConnectExisting,
  findExistingChromeDebugPort,
  getPageSession,
  waitForNewTab,
  evaluate,
  sleep,
  type ChromeSession,
  type CdpConnection,
} from "./cdp.ts";
import { getPlatformDefinition, type PlatformId, type GenericPlatformDefinition, type InputMode } from "./platforms.ts";

interface ImageInfo {
  placeholder: string;
  localPath: string;
  originalPath: string;
}

interface ArticleOptions {
  platform: PlatformId;
  title?: string;
  htmlFile?: string;
  markdownFile?: string;
  theme?: string;
  color?: string;
  citeStatus?: boolean;
  author?: string;
  summary?: string;
  contentImages?: ImageInfo[];
  submit?: boolean;
  profileDir?: string;
  cdpPort?: number;
}

function ensureScriptDependencies(): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const nodeModulesDir = path.join(__dirname, "node_modules");
  const packageJsonPath = path.join(__dirname, "package.json");
  if (!fs.existsSync(packageJsonPath)) return;
  if (fs.existsSync(nodeModulesDir)) return;

  throw new Error(
    `Missing script dependencies in ${nodeModulesDir}. Run: (cd "${__dirname}" && npx -y bun install)`,
  );
}

async function waitForLogin(session: ChromeSession, config: GenericPlatformDefinition, timeoutMs = 180_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await evaluate<{ href: string; body: string }>(session, `({
      href: window.location.href,
      body: document.body?.innerText?.slice(0, 2000) || ''
    })`);
    const hasEditor = await editorIsReady(session, config);
    const loginReady = config.loggedInUrlIncludes
      ? state.href.includes(config.loggedInUrlIncludes)
      : state.href.includes(config.urlPattern) && !config.loginKeywords.test(state.body);
    if (loginReady || hasEditor) {
      return true;
    }
    await sleep(2000);
  }
  return false;
}

async function waitForExpression(session: ChromeSession, expression: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evaluate<boolean>(session, expression);
    if (found) return true;
    await sleep(500);
  }
  return false;
}

function selectorsPresentExpression(selectors: string[]): string {
  return `(${JSON.stringify(selectors)}).some((selector) => !!document.querySelector(selector))`;
}

async function editorIsReady(session: ChromeSession, config: GenericPlatformDefinition): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const titleSelectors = ${JSON.stringify(config.titleSelectors)};
      const editorSelectors = ${JSON.stringify(config.editorSelectors)};
      return titleSelectors.some((selector) => !!document.querySelector(selector))
        && editorSelectors.some((selector) => !!document.querySelector(selector));
    })()
  `);
}

async function clickButtonByTexts(session: ChromeSession, texts: string[]): Promise<boolean> {
  const result = await session.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
    expression: `
      (function() {
        const texts = ${JSON.stringify(texts)};
        const nodes = Array.from(document.querySelectorAll('*'));
        for (const text of texts) {
          const matches = nodes.filter((el) => {
            const content = (el.innerText || el.textContent || '').trim();
            if (!content || !content.includes(text)) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 20 && rect.height > 20;
          });
          const node = matches.sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return ra.width * ra.height - rb.width * rb.height;
          })[0];
          if (node) {
            node.scrollIntoView({ block: 'center' });
            const rect = node.getBoundingClientRect();
            return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
          }
        }
        return 'null';
      })()
    `,
    returnByValue: true,
  }, { sessionId: session.sessionId });

  if (result.result.value === "null") return false;
  const pos = JSON.parse(result.result.value);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, { sessionId: session.sessionId });
  await sleep(100);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, { sessionId: session.sessionId });
  return true;
}

async function clickSelector(session: ChromeSession, selector: string): Promise<boolean> {
  const result = await session.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
    expression: `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'null';
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      })()
    `,
    returnByValue: true,
  }, { sessionId: session.sessionId });

  if (result.result.value === "null") return false;
  const pos = JSON.parse(result.result.value);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, { sessionId: session.sessionId });
  await sleep(100);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, { sessionId: session.sessionId });
  return true;
}

async function focusFirstSelector(session: ChromeSession, selectors: string[]): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const selectors = ${JSON.stringify(selectors)};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        el.scrollIntoView({ block: 'center' });
        el.focus();
        if ('select' in el) el.select();
        return true;
      }
      return false;
    })()
  `);
}

async function setFieldValue(
  session: ChromeSession,
  selectors: string[],
  value: string,
  mode: InputMode = "setValue",
): Promise<boolean> {
  const focused = await focusFirstSelector(session, selectors);
  if (!focused) return false;

  if (mode === "insertText") {
    await session.cdp.send("Input.insertText", { text: value }, { sessionId: session.sessionId });
    return true;
  }

  return await evaluate<boolean>(session, `
    (function() {
      const selectors = ${JSON.stringify(selectors)};
      for (const selector of selectors) {
        const target = document.querySelector(selector);
        if (!target) continue;
        target.focus();
        if ('value' in target) {
          target.value = ${JSON.stringify(value)};
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          target.dispatchEvent(new Event('blur', { bubbles: true }));
        } else {
          target.textContent = ${JSON.stringify(value)};
        }
        return true;
      }
      return false;
    })()
  `);
}

async function clearFieldValue(session: ChromeSession, selectors: string[]): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const selectors = ${JSON.stringify(selectors)};
      for (const selector of selectors) {
        const target = document.querySelector(selector);
        if (!target) continue;

        if (target.tagName === 'IFRAME') {
          try {
            const frame = target;
            const doc = frame.contentDocument;
            const win = frame.contentWindow;
            if (!doc || !doc.body) continue;
            doc.body.innerHTML = '';
            doc.body.textContent = '';
            win?.focus();
            doc.body.focus?.();
            return true;
          } catch {
            continue;
          }
        }

        target.focus();
        if ('value' in target) {
          target.value = '';
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          target.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        }

        if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') {
          target.innerHTML = '';
          target.textContent = '';
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        }

        target.textContent = '';
        return true;
      }
      return false;
    })()
  `);
}

async function fillTitle(session: ChromeSession, config: GenericPlatformDefinition, title: string): Promise<void> {
  if (config.clearTitleBeforeFill) {
    await clearFieldValue(session, config.titleSelectors);
  }
  const filled = await setFieldValue(session, config.titleSelectors, title, config.titleInputMode ?? "insertText");
  if (!filled) throw new Error(`${config.displayName} title field not found`);
}

async function focusLargestEditor(session: ChromeSession, config: GenericPlatformDefinition): Promise<boolean> {
  const result = await session.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
    expression: `
      (function() {
        const selectors = ${JSON.stringify(config.editorSelectors)};
        const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
        const filtered = candidates.filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 16) return false;
          const text = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('data-placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '');
          return !/标题|摘要|简介/.test(text);
        });
        const best = filtered.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        })[0];
        if (!best) return 'null';
        best.scrollIntoView({ block: 'center' });
        const rect = best.getBoundingClientRect();
        return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      })()
    `,
    returnByValue: true,
  }, { sessionId: session.sessionId });

  if (result.result.value === "null") return false;
  const pos = JSON.parse(result.result.value);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, { sessionId: session.sessionId });
  await sleep(50);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, { sessionId: session.sessionId });
  return true;
}

async function sendCopy(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  if (process.platform === "darwin") {
    spawnSync("osascript", ["-e", 'tell application "System Events" to keystroke "c" using command down']);
  } else if (process.platform === "linux") {
    spawnSync("xdotool", ["key", "ctrl+c"]);
  } else if (cdp && sessionId) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", modifiers: 2, windowsVirtualKeyCode: 67 }, { sessionId });
    await sleep(50);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", modifiers: 2, windowsVirtualKeyCode: 67 }, { sessionId });
  }
}

async function sendPaste(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  if (process.platform === "darwin") {
    spawnSync("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
  } else if (process.platform === "linux") {
    spawnSync("xdotool", ["key", "ctrl+v"]);
  } else if (cdp && sessionId) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", modifiers: 2, windowsVirtualKeyCode: 86 }, { sessionId });
    await sleep(50);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", modifiers: 2, windowsVirtualKeyCode: 86 }, { sessionId });
  }
}

function normalizePlainText(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToPlainText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withBreaks = withoutScripts
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|blockquote|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");
  return normalizePlainText(decodeBasicHtmlEntities(withoutTags));
}

function extractOutputFragment(html: string): string {
  const match = html.match(/<div[^>]+id=["']output["'][^>]*>([\s\S]*?)<\/div>\s*<\/body>/i);
  if (match?.[1]) return match[1];
  return html;
}

function sanitizeHtmlForPlatform(platform: PlatformId, html: string): string {
  if (platform === "zhihu") {
    return html.replace(/(<li\b[^>]*>\s*)([•●▪◦·]\s*)+/gi, "$1");
  }
  return html;
}

function prepareHtmlForBrowserCopy(
  platform: PlatformId,
  htmlFilePath: string,
  contentImages: ImageInfo[] = [],
): { path: string; expectedText: string } {
  const absolutePath = path.isAbsolute(htmlFilePath) ? htmlFilePath : path.resolve(process.cwd(), htmlFilePath);
  let html = fs.readFileSync(absolutePath, "utf-8");
  html = sanitizeHtmlForPlatform(platform, html);

  if (contentImages.length > 0) {
    for (const img of contentImages) {
      const escapedPlaceholder = img.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedLocalPath = img.localPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      html = html.replace(
        new RegExp(`<img[^>]*(?:src=["']${escapedPlaceholder}["']|data-local-path=["']${escapedLocalPath}["'])[^>]*>`, "gi"),
        img.placeholder,
      );
    }
  }

  const fragment = extractOutputFragment(html);
  const preparedHtml = html.includes('id="output"') || html.includes("id='output'")
    ? html
    : `<!doctype html><html><body><div id="output">${fragment}</div></body></html>`;
  fs.writeFileSync(absolutePath, preparedHtml, "utf-8");
  return { path: absolutePath, expectedText: htmlToPlainText(fragment) };
}

function readClipboardText(): string {
  if (process.platform === "darwin") {
    const result = spawnSync("pbpaste", [], { stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) {
      throw new Error(`Failed to read clipboard via pbpaste: ${result.stderr?.toString().trim() || ""}`);
    }
    return result.stdout.toString();
  }

  if (process.platform === "linux") {
    const wlPaste = spawnSync("which", ["wl-paste"], { stdio: "pipe" });
    if (wlPaste.status === 0) {
      const result = spawnSync("wl-paste", ["--no-newline"], { stdio: ["ignore", "pipe", "pipe"] });
      if (result.status === 0) return result.stdout.toString();
    }
    const xclip = spawnSync("which", ["xclip"], { stdio: "pipe" });
    if (xclip.status === 0) {
      const result = spawnSync("xclip", ["-selection", "clipboard", "-o"], { stdio: ["ignore", "pipe", "pipe"] });
      if (result.status === 0) return result.stdout.toString();
    }
    throw new Error("Failed to read clipboard on Linux. Install wl-paste or xclip.");
  }

  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"], { stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) {
      throw new Error(`Failed to read clipboard on Windows: ${result.stderr?.toString().trim() || ""}`);
    }
    return result.stdout.toString();
  }

  throw new Error(`Clipboard read not supported on platform: ${process.platform}`);
}

async function copyHtmlFromBrowser(
  cdp: CdpConnection,
  platform: PlatformId,
  htmlFilePath: string,
  contentImages: ImageInfo[] = [],
): Promise<string> {
  const prepared = prepareHtmlForBrowserCopy(platform, htmlFilePath, contentImages);
  const fileUrl = `file://${prepared.path}`;
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: fileUrl });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, { sessionId });
  await cdp.send("Runtime.enable", {}, { sessionId });
  await sleep(1500);

  if (contentImages.length > 0) {
    await cdp.send("Runtime.evaluate", {
      expression: `
        (function() {
          const replacements = ${JSON.stringify(contentImages.map((img) => ({ placeholder: img.placeholder, localPath: img.localPath })))};
          for (const r of replacements) {
            const imgs = document.querySelectorAll('img[src="' + r.placeholder + '"], img[data-local-path="' + r.localPath + '"]');
            for (const img of imgs) {
              const text = document.createTextNode(r.placeholder);
              img.parentNode.replaceChild(text, img);
            }
          }
          return true;
        })()
      `,
      returnByValue: true,
    }, { sessionId });
  }

  await cdp.send("Runtime.evaluate", {
    expression: `
      (function() {
        const output = document.querySelector('#output') || document.body;
        const range = document.createRange();
        range.selectNodeContents(output);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()
    `,
    returnByValue: true,
  }, { sessionId });
  await sleep(300);
  await sendCopy(cdp, sessionId);
  await sleep(500);

  const clipboardText = normalizePlainText(readClipboardText());
  const expectedText = prepared.expectedText;
  const sample = expectedText.slice(0, 80);
  if (!clipboardText || clipboardText.length < Math.min(20, sample.length) || (sample && !clipboardText.includes(sample))) {
    throw new Error("Clipboard verification failed: copied content does not match expected article text");
  }

  await cdp.send("Target.closeTarget", { targetId });
  return expectedText;
}

async function copyImageToClipboard(imagePath: string): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const copyScript = path.join(__dirname, "./copy-to-clipboard.ts");
  const result = spawnSync("npx", ["-y", "bun", copyScript, "image", imagePath], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Failed to copy image: ${imagePath}`);
}

async function selectAndReplacePlaceholder(
  session: ChromeSession,
  config: GenericPlatformDefinition,
  placeholder: string,
): Promise<boolean> {
  const result = await session.cdp.send<{ result: { value: boolean } }>("Runtime.evaluate", {
    expression: `
      (function() {
        const selectors = ${JSON.stringify(config.editorSelectors)};
        const roots = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
        const placeholder = ${JSON.stringify(placeholder)};
        for (const root of roots) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
          let node;
          while ((node = walker.nextNode())) {
            const text = node.textContent || '';
            const idx = text.indexOf(placeholder);
            if (idx === -1) continue;
            root.scrollIntoView({ block: 'center' });
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + placeholder.length);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
          }
        }
        return false;
      })()
    `,
    returnByValue: true,
  }, { sessionId: session.sessionId });
  return result.result.value;
}

async function pressDeleteKey(session: ChromeSession): Promise<void> {
  await session.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, { sessionId: session.sessionId });
  await sleep(50);
  await session.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, { sessionId: session.sessionId });
}

async function fillSummaryIfPresent(session: ChromeSession, config: GenericPlatformDefinition, summary: string): Promise<boolean> {
  return await setFieldValue(session, config.summarySelectors, summary, config.summaryInputMode ?? "setValue");
}

async function parseMarkdownWithPlaceholders(
  markdownPath: string,
  platform: PlatformId,
  theme?: string,
  color?: string,
  citeStatus: boolean = true,
): Promise<{ title: string; author: string; summary: string; htmlPath: string; contentImages: ImageInfo[] }> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const mdToArticleScript = path.join(__dirname, "md-to-article.ts");
  const args = ["-y", "bun", mdToArticleScript, markdownPath, "--platform", platform];
  if (theme) args.push("--theme", theme);
  if (color) args.push("--color", color);
  if (!citeStatus) args.push("--no-cite");

  const result = spawnSync("npx", args, { stdio: ["inherit", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`Failed to parse markdown: ${result.stderr?.toString() || ""}`);
  }
  return JSON.parse(result.stdout.toString());
}

async function attachPageSession(cdp: CdpConnection, targetId: string): Promise<ChromeSession> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, { sessionId });
  await cdp.send("Runtime.enable", {}, { sessionId });
  await cdp.send("DOM.enable", {}, { sessionId });
  return { cdp, sessionId, targetId };
}

async function ensurePlatformTab(cdp: CdpConnection, config: GenericPlatformDefinition): Promise<ChromeSession> {
  const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>("Target.getTargets");
  const pageTarget = targets.targetInfos.find((target) => target.type === "page" && target.url.includes(config.urlPattern));
  if (pageTarget) {
    return await attachPageSession(cdp, pageTarget.targetId);
  }

  await cdp.send("Target.createTarget", { url: config.homeUrl });
  await sleep(5000);
  return await getPageSession(cdp, config.urlPattern);
}

async function clickMenuByText(session: ChromeSession, text: string): Promise<boolean> {
  const result = await session.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
    expression: `
      (function() {
        const items = document.querySelectorAll('.new-creation__menu .new-creation__menu-item');
        for (const item of items) {
          const title = item.querySelector('.new-creation__menu-title');
          if (title && title.textContent?.trim() === ${JSON.stringify(text)}) {
            item.scrollIntoView({ block: 'center' });
            const rect = item.getBoundingClientRect();
            return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
          }
        }
        return 'null';
      })()
    `,
    returnByValue: true,
  }, { sessionId: session.sessionId });

  if (result.result.value === "null") return false;
  const pos = JSON.parse(result.result.value);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, { sessionId: session.sessionId });
  await sleep(100);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, { sessionId: session.sessionId });
  return true;
}

async function openEditorSession(cdp: CdpConnection, baseSession: ChromeSession, config: GenericPlatformDefinition): Promise<ChromeSession> {
  const currentHref = await evaluate<string>(baseSession, "window.location.href");
  if (currentHref.startsWith(config.editorUrl) && await editorIsReady(baseSession, config)) {
    return baseSession;
  }

  if (config.openStrategy === "wechat-menu-article") {
    const menuReady = await waitForExpression(baseSession, `!!document.querySelector('.new-creation__menu')`, 20_000);
    if (!menuReady) throw new Error(`${config.displayName} home menu did not load`);

    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>("Target.getTargets");
    const initialIds = new Set(targets.targetInfos.map((target) => target.targetId));
    const clicked = await clickMenuByText(baseSession, config.openMenuText ?? "文章");
    if (!clicked) throw new Error(`${config.displayName} article menu not found`);
    await sleep(3000);
    const editorTargetId = await waitForNewTab(cdp, initialIds, config.urlPattern);
    return await attachPageSession(cdp, editorTargetId);
  }

  if (config.openStrategy === "click-text") {
    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>("Target.getTargets");
    const initialIds = new Set(targets.targetInfos.map((target) => target.targetId));
    if (config.openMenuSelector) {
      const menuClicked = await clickSelector(baseSession, config.openMenuSelector);
      if (!menuClicked) throw new Error(`${config.displayName} open editor menu not found`);
      await sleep(1000);
    }
    const clicked = await clickButtonByTexts(baseSession, [config.openMenuText ?? ""]);
    if (!clicked) throw new Error(`${config.displayName} open editor entry not found`);
    await sleep(3000);

    try {
      const editorTargetId = await waitForNewTab(cdp, initialIds, config.urlPattern, 15_000);
      return await attachPageSession(cdp, editorTargetId);
    } catch {
      await sleep(3000);
      return baseSession;
    }
  }

  await baseSession.cdp.send("Page.navigate", { url: config.editorUrl }, { sessionId: baseSession.sessionId });
  await sleep(5000);
  return baseSession;
}

async function closeCurrentDraftPage(session: ChromeSession, platformId: string): Promise<void> {
  try {
    await session.cdp.send("Target.closeTarget", { targetId: session.targetId });
  } catch (error) {
    console.warn(`[${platformId}] Failed to close draft page: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function postArticle(options: ArticleOptions): Promise<void> {
  const config = getPlatformDefinition(options.platform);
  const { markdownFile, htmlFile, title, theme, color, citeStatus = true, author, summary, submit = false, profileDir, cdpPort } = options;

  let contentImages = options.contentImages || [];
  let effectiveTitle = title || "";
  let effectiveAuthor = author || "";
  let effectiveSummary = summary || "";
  let effectiveHtmlFile = htmlFile;
  let expectedBodyText = "";
  let launchedChrome: ReturnType<typeof launchChrome>["chrome"] | undefined;

  if (markdownFile) {
    console.log(`[${config.id}] Parsing markdown: ${markdownFile}`);
    const parsed = await parseMarkdownWithPlaceholders(markdownFile, config.id, theme, color, citeStatus);
    effectiveTitle = effectiveTitle || parsed.title;
    effectiveAuthor = effectiveAuthor || parsed.author;
    effectiveSummary = effectiveSummary || parsed.summary;
    effectiveHtmlFile = parsed.htmlPath;
    contentImages = parsed.contentImages;
  }

  let cdp: CdpConnection;
  const portToTry = cdpPort ?? await findExistingChromeDebugPort();
  if (portToTry) {
    const existing = await tryConnectExisting(portToTry);
    if (existing) {
      console.log(`[cdp] Connected to existing Chrome on port ${portToTry}`);
      cdp = existing;
    } else {
      const launched = await launchChrome(config.homeUrl, profileDir ?? config.profileDir, config.id);
      cdp = launched.cdp;
      launchedChrome = launched.chrome;
    }
  } else {
    const launched = await launchChrome(config.homeUrl, profileDir ?? config.profileDir, config.id);
    cdp = launched.cdp;
    launchedChrome = launched.chrome;
  }

  try {
    console.log(`[${config.id}] Waiting for page load...`);
    await sleep(3000);
    let session = await ensurePlatformTab(cdp, config);
    const href = await evaluate<string>(session, "window.location.href");
    const bodyText = await evaluate<string>(session, "document.body?.innerText || ''");
    const loggedIn = config.loggedInUrlIncludes
      ? href.includes(config.loggedInUrlIncludes)
      : href.includes(config.urlPattern) && !config.loginKeywords.test(bodyText);
    if (!loggedIn) {
      console.log(`[${config.id}] Not logged in. Please complete login in Chrome...`);
      const loggedIn = await waitForLogin(session, config);
      if (!loggedIn) throw new Error(`${config.displayName} login timeout`);
    }
    console.log(`[${config.id}] Logged in.`);

    session = await openEditorSession(cdp, session, config);

    const ready = await waitForExpression(session, selectorsPresentExpression(config.titleSelectors.concat(config.editorSelectors)), 30_000);
    if (!ready) throw new Error(`${config.displayName} editor did not load`);

    if (effectiveTitle) {
      console.log(`[${config.id}] Filling title...`);
      await fillTitle(session, config, effectiveTitle);
      await sleep(500);
    }

    if (effectiveAuthor && config.authorSelectors?.length) {
      const authorFilled = await setFieldValue(session, config.authorSelectors, effectiveAuthor, config.authorInputMode ?? "setValue");
      if (authorFilled) {
        console.log(`[${config.id}] Author filled.`);
      }
    }

    console.log(`[${config.id}] Focusing editor...`);
    const editorFocused = await focusLargestEditor(session, config);
    if (!editorFocused) throw new Error(`${config.displayName} editor not found`);
    await sleep(500);

    if (config.clearBodyBeforePaste) {
      const cleared = await clearFieldValue(session, config.editorSelectors);
      if (cleared) {
        console.log(`[${config.id}] Existing body content cleared.`);
        await sleep(300);
        await focusLargestEditor(session, config);
        await sleep(200);
      }
    }

    if (effectiveHtmlFile && fs.existsSync(effectiveHtmlFile)) {
      console.log(`[${config.id}] Copying HTML content from: ${effectiveHtmlFile}`);
      expectedBodyText = await copyHtmlFromBrowser(cdp, config.id, effectiveHtmlFile, contentImages);
      console.log(`[${config.id}] Clipboard content verified OK.`);
      await sleep(500);
      console.log(`[${config.id}] Pasting into editor...`);
      await sendPaste(session.cdp, session.sessionId);
      await sleep(2500);

      const bodySample = expectedBodyText.slice(0, 80);
      const editorHasContent = await evaluate<boolean>(session, `
        (function() {
          const selectors = ${JSON.stringify(config.bodyTextSelector ? [config.bodyTextSelector] : config.editorSelectors)};
          const roots = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
          return roots.some((root) => {
            const text = (root.innerText || root.textContent || '').trim();
            return text.length > 0 && ${JSON.stringify(bodySample)} ? text.includes(${JSON.stringify(bodySample)}) : text.length > 0;
          });
        })()
      `);
      if (editorHasContent) console.log(`[${config.id}] Body content verified OK.`);

      if (contentImages.length > 0) {
        console.log(`[${config.id}] Inserting ${contentImages.length} images...`);
        for (const image of contentImages) {
          const found = await selectAndReplacePlaceholder(session, config, image.placeholder);
          if (!found) {
            console.warn(`[${config.id}] Placeholder not found: ${image.placeholder}`);
            continue;
          }
          await sleep(300);
          await copyImageToClipboard(image.localPath);
          await sleep(300);
          await pressDeleteKey(session);
          await sleep(200);
          await sendPaste(session.cdp, session.sessionId);
          await sleep(2500);
        }
      }
    }

    if (effectiveSummary) {
      const summaryFilled = await fillSummaryIfPresent(session, config, effectiveSummary);
      if (summaryFilled) {
        console.log(`[${config.id}] Summary filled.`);
      } else {
        console.log(`[${config.id}] Summary field not found; skipped.`);
      }
    }

    if (!submit && config.autoSaveDraft) {
      console.log(`[${config.id}] Waiting for auto-save...`);
      await sleep(4000);
    } else {
      console.log(`[${config.id}] ${submit ? "Publishing" : "Saving draft"}...`);
      const clicked = submit
        ? (config.publishSelector ? await clickSelector(session, config.publishSelector) : await clickButtonByTexts(session, config.publishTexts ?? []))
        : (config.saveDraftSelector ? await clickSelector(session, config.saveDraftSelector) : await clickButtonByTexts(session, config.saveDraftTexts ?? []));
      if (!clicked) throw new Error(`${config.displayName} ${submit ? "publish" : "save draft"} button not found`);
      await sleep(3000);
    }

    if (submit && (config.confirmPublishSelector || config.confirmPublishTexts?.length)) {
      if (config.confirmPublishSelector) {
        await clickSelector(session, config.confirmPublishSelector);
      } else if (config.confirmPublishTexts?.length) {
        await clickButtonByTexts(session, config.confirmPublishTexts);
      }
      await sleep(3000);
    }

    console.log(`[${config.id}] ${submit ? "Publish flow triggered" : "Draft flow triggered"}. Closing draft page...`);
    await closeCurrentDraftPage(session, config.id);
  } finally {
    cdp.close();
    if (launchedChrome && !launchedChrome.killed) {
      console.log(`[${config.id}] Closing launched browser...`);
      try {
        launchedChrome.kill("SIGTERM");
      } catch (error) {
        console.warn(`[${config.id}] Failed to close launched browser: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function printUsage(): never {
  console.log(`Post article to a generic browser-based platform

Usage:
  npx -y bun browser-article.ts --platform <wechat|toutiao|baijiahao|zhihu> [options]

Options:
  --platform <id>     Platform id
  --title <text>      Article title
  --html <path>       HTML file to paste
  --markdown <path>   Markdown file to convert and post
  --theme <name>      Theme for markdown renderer
  --color <name>      Primary color preset or hex
  --no-cite           Keep ordinary external links inline in markdown mode
  --author <name>     Author name (metadata only)
  --summary <text>    Optional summary
  --submit            Publish instead of saving draft
  --profile <dir>     Chrome profile directory
  --cdp-port <port>   Connect to an existing Chrome debug port
`);
  process.exit(0);
}

async function main(): Promise<void> {
  ensureScriptDependencies();

  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) printUsage();

  let platform: PlatformId | undefined;
  let title: string | undefined;
  let htmlFile: string | undefined;
  let markdownFile: string | undefined;
  let theme: string | undefined;
  let color: string | undefined;
  let citeStatus = true;
  let author: string | undefined;
  let summary: string | undefined;
  let submit = false;
  let profileDir: string | undefined;
  let cdpPort: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--platform" && args[i + 1]) platform = args[++i] as PlatformId;
    else if (arg === "--title" && args[i + 1]) title = args[++i];
    else if (arg === "--html" && args[i + 1]) htmlFile = args[++i];
    else if (arg === "--markdown" && args[i + 1]) markdownFile = args[++i];
    else if (arg === "--theme" && args[i + 1]) theme = args[++i];
    else if (arg === "--color" && args[i + 1]) color = args[++i];
    else if (arg === "--cite") citeStatus = true;
    else if (arg === "--no-cite") citeStatus = false;
    else if (arg === "--author" && args[i + 1]) author = args[++i];
    else if (arg === "--summary" && args[i + 1]) summary = args[++i];
    else if (arg === "--submit") submit = true;
    else if (arg === "--profile" && args[i + 1]) profileDir = args[++i];
    else if (arg === "--cdp-port" && args[i + 1]) cdpPort = parseInt(args[++i]!, 10);
  }

  if (!platform) {
    console.error("Error: --platform is required");
    process.exit(1);
  }
  if (!markdownFile && !htmlFile) {
    console.error("Error: --markdown or --html is required");
    process.exit(1);
  }

  await postArticle({ platform, title, htmlFile, markdownFile, theme, color, citeStatus, author, summary, submit, profileDir, cdpPort });
}

await main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
