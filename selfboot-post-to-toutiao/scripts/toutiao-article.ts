import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { launchChrome, tryConnectExisting, findExistingChromeDebugPort, getPageSession, clickElement, evaluate, sleep, type ChromeSession, type CdpConnection } from './cdp.ts';

const TOUTIAO_HOME_URL = 'https://mp.toutiao.com/';
const TOUTIAO_EDITOR_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish';

interface ImageInfo {
  placeholder: string;
  localPath: string;
  originalPath: string;
}

interface ArticleOptions {
  title: string;
  content?: string;
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

async function waitForLogin(session: ChromeSession, timeoutMs = 180_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await evaluate<{ href: string; body: string }>(session, `({
      href: window.location.href,
      body: document.body?.innerText?.slice(0, 1000) || ''
    })`);
    if (state.href.includes('mp.toutiao.com') && !/登录|登录后|扫码/.test(state.body)) {
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

async function clickButtonByTexts(session: ChromeSession, texts: string[]): Promise<boolean> {
  const result = await session.cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
    expression: `
      (function() {
        const texts = ${JSON.stringify(texts)};
        const nodes = Array.from(document.querySelectorAll('button, a, div, span'));
        for (const text of texts) {
          const node = nodes.find((el) => {
            const content = (el.innerText || el.textContent || '').trim();
            if (!content) return false;
            if (!content.includes(text)) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 20 && rect.height > 20;
          });
          if (node) {
            const rect = node.getBoundingClientRect();
            return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
          }
        }
        return 'null';
      })()
    `,
    returnByValue: true,
  }, { sessionId: session.sessionId });

  if (result.result.value === 'null') return false;
  const pos = JSON.parse(result.result.value);
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, { sessionId: session.sessionId });
  await sleep(100);
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, { sessionId: session.sessionId });
  return true;
}

async function focusTitleField(session: ChromeSession): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const selectors = [
        'textarea[placeholder*="标题"]',
        'input[placeholder*="标题"]',
        'textarea',
        'input[type="text"]'
      ];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        if (selector.startsWith('textarea') || selector.startsWith('input[placeholder') || /标题/.test(placeholder)) {
          el.focus();
          if ('select' in el) el.select();
          return true;
        }
      }
      return false;
    })()
  `);
}

async function fillTitle(session: ChromeSession, title: string): Promise<void> {
  const focused = await focusTitleField(session);
  if (!focused) throw new Error('Title field not found');
  await session.cdp.send('Input.insertText', { text: title }, { sessionId: session.sessionId });
}

async function focusLargestEditor(session: ChromeSession): Promise<boolean> {
  const result = await session.cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
    expression: `
      (function() {
        const candidates = Array.from(document.querySelectorAll('.ProseMirror, [contenteditable="true"], [role="textbox"]'));
          const filtered = candidates.filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 200 || rect.height < 80) return false;
            const text = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('data-placeholder') || '');
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

  if (result.result.value === 'null') return false;
  const pos = JSON.parse(result.result.value);
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, { sessionId: session.sessionId });
  await sleep(50);
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, { sessionId: session.sessionId });
  return true;
}

async function sendCopy(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down']);
  } else if (process.platform === 'linux') {
    spawnSync('xdotool', ['key', 'ctrl+c']);
  } else if (cdp && sessionId) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 }, { sessionId });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 }, { sessionId });
  }
}

async function sendPaste(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  } else if (process.platform === 'linux') {
    spawnSync('xdotool', ['key', 'ctrl+v']);
  } else if (cdp && sessionId) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 }, { sessionId });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 }, { sessionId });
  }
}

function normalizePlainText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToPlainText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const withBreaks = withoutScripts
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|blockquote|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const withoutTags = withBreaks.replace(/<[^>]+>/g, ' ');
  return normalizePlainText(decodeBasicHtmlEntities(withoutTags));
}

function extractOutputFragment(html: string): string {
  const match = html.match(/<div[^>]+id=["']output["'][^>]*>([\s\S]*?)<\/div>\s*<\/body>/i);
  if (match?.[1]) return match[1];
  return html;
}

function prepareHtmlForBrowserCopy(htmlFilePath: string, contentImages: ImageInfo[] = []): { path: string; expectedText: string } {
  const absolutePath = path.isAbsolute(htmlFilePath) ? htmlFilePath : path.resolve(process.cwd(), htmlFilePath);
  let html = fs.readFileSync(absolutePath, 'utf-8');

  if (contentImages.length > 0) {
    for (const img of contentImages) {
      const escapedPlaceholder = img.placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedLocalPath = img.localPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(
        new RegExp(`<img[^>]*(?:src=["']${escapedPlaceholder}["']|data-local-path=["']${escapedLocalPath}["'])[^>]*>`, 'gi'),
        img.placeholder,
      );
    }
  }

  const fragment = extractOutputFragment(html);
  const preparedHtml = html.includes('id="output"') || html.includes("id='output'")
    ? html
    : `<!doctype html><html><body><div id="output">${fragment}</div></body></html>`;
  fs.writeFileSync(absolutePath, preparedHtml, 'utf-8');
  return { path: absolutePath, expectedText: htmlToPlainText(fragment) };
}

function readClipboardText(): string {
  if (process.platform === 'darwin') {
    const result = spawnSync('pbpaste', [], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) {
      throw new Error(`Failed to read clipboard via pbpaste: ${result.stderr?.toString().trim() || ''}`);
    }
    return result.stdout.toString();
  }

  if (process.platform === 'linux') {
    const wlPaste = spawnSync('which', ['wl-paste'], { stdio: 'pipe' });
    if (wlPaste.status === 0) {
      const result = spawnSync('wl-paste', ['--no-newline'], { stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.status === 0) return result.stdout.toString();
    }
    const xclip = spawnSync('which', ['xclip'], { stdio: 'pipe' });
    if (xclip.status === 0) {
      const result = spawnSync('xclip', ['-selection', 'clipboard', '-o'], { stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.status === 0) return result.stdout.toString();
    }
    throw new Error('Failed to read clipboard on Linux. Install wl-paste or xclip.');
  }

  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) {
      throw new Error(`Failed to read clipboard on Windows: ${result.stderr?.toString().trim() || ''}`);
    }
    return result.stdout.toString();
  }

  throw new Error(`Clipboard read not supported on platform: ${process.platform}`);
}

async function copyHtmlFromBrowser(cdp: CdpConnection, htmlFilePath: string, contentImages: ImageInfo[] = []): Promise<void> {
  const prepared = prepareHtmlForBrowserCopy(htmlFilePath, contentImages);
  const fileUrl = `file://${prepared.path}`;
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: fileUrl });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, { sessionId });
  await cdp.send('Runtime.enable', {}, { sessionId });
  await sleep(1500);

  if (contentImages.length > 0) {
    await cdp.send('Runtime.evaluate', {
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

  await cdp.send('Runtime.evaluate', {
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
    throw new Error('Clipboard verification failed: copied content does not match expected article text');
  }

  console.log('[toutiao] Clipboard content verified OK.');
  await cdp.send('Target.closeTarget', { targetId });
}

async function copyImageToClipboard(imagePath: string): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const copyScript = path.join(__dirname, './copy-to-clipboard.ts');
  const result = spawnSync('npx', ['-y', 'bun', copyScript, 'image', imagePath], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Failed to copy image: ${imagePath}`);
}

async function selectAndReplacePlaceholder(session: ChromeSession, placeholder: string): Promise<boolean> {
  const result = await session.cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', {
    expression: `
      (function() {
        const roots = Array.from(document.querySelectorAll('.ProseMirror, [contenteditable="true"], [role="textbox"]'));
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
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, { sessionId: session.sessionId });
  await sleep(50);
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, { sessionId: session.sessionId });
}

async function fillSummaryIfPresent(session: ChromeSession, summary: string): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const candidates = Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"]'));
      const target = candidates.find((el) => {
        const text = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '');
        return /摘要|简介/.test(text);
      });
      if (!target) return false;
      target.focus();
      if ('value' in target) {
        target.value = ${JSON.stringify(summary)};
        target.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        target.textContent = ${JSON.stringify(summary)};
      }
      return true;
    })()
  `);
}

async function parseMarkdownWithPlaceholders(
  markdownPath: string,
  theme?: string,
  color?: string,
  citeStatus: boolean = true,
): Promise<{ title: string; author: string; summary: string; htmlPath: string; contentImages: ImageInfo[] }> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const mdToToutiaoScript = path.join(__dirname, 'md-to-toutiao.ts');
  const args = ['-y', 'bun', mdToToutiaoScript, markdownPath];
  if (theme) args.push('--theme', theme);
  if (color) args.push('--color', color);
  if (!citeStatus) args.push('--no-cite');

  const result = spawnSync('npx', args, { stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`Failed to parse markdown: ${result.stderr?.toString() || ''}`);
  }
  return JSON.parse(result.stdout.toString());
}

async function postArticle(options: ArticleOptions): Promise<void> {
  const { markdownFile, htmlFile, title, theme, color, citeStatus = true, author, summary, submit = false, profileDir, cdpPort } = options;
  let contentImages = options.contentImages || [];
  let effectiveTitle = title || '';
  let effectiveAuthor = author || '';
  let effectiveSummary = summary || '';
  let effectiveHtmlFile = htmlFile;

  if (markdownFile) {
    console.log(`[toutiao] Parsing markdown: ${markdownFile}`);
    const parsed = await parseMarkdownWithPlaceholders(markdownFile, theme, color, citeStatus);
    effectiveTitle = effectiveTitle || parsed.title;
    effectiveAuthor = effectiveAuthor || parsed.author;
    effectiveSummary = effectiveSummary || parsed.summary;
    effectiveHtmlFile = parsed.htmlPath;
    contentImages = parsed.contentImages;
  }

  let cdp: CdpConnection;
  let chrome: ReturnType<typeof import('node:child_process').spawn> | null = null;
  const portToTry = cdpPort ?? await findExistingChromeDebugPort();
  if (portToTry) {
    const existing = await tryConnectExisting(portToTry);
    if (existing) {
      console.log(`[cdp] Connected to existing Chrome on port ${portToTry}`);
      cdp = existing;
    } else {
      const launched = await launchChrome(TOUTIAO_HOME_URL, profileDir);
      cdp = launched.cdp;
      chrome = launched.chrome;
    }
  } else {
    const launched = await launchChrome(TOUTIAO_HOME_URL, profileDir);
    cdp = launched.cdp;
    chrome = launched.chrome;
  }

  try {
    console.log('[toutiao] Waiting for page load...');
    await sleep(3000);
    let session: ChromeSession;
    if (!chrome) {
      const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
      const toutiaoTab = targets.targetInfos.find((t) => t.type === 'page' && t.url.includes('mp.toutiao.com'));
      if (toutiaoTab) {
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: toutiaoTab.targetId, flatten: true });
        await cdp.send('Page.enable', {}, { sessionId });
        await cdp.send('Runtime.enable', {}, { sessionId });
        await cdp.send('DOM.enable', {}, { sessionId });
        session = { cdp, sessionId, targetId: toutiaoTab.targetId };
      } else {
        await cdp.send('Target.createTarget', { url: TOUTIAO_HOME_URL });
        await sleep(5000);
        session = await getPageSession(cdp, 'mp.toutiao.com');
      }
    } else {
      session = await getPageSession(cdp, 'mp.toutiao.com');
    }

    const href = await evaluate<string>(session, 'window.location.href');
    if (!href.includes('mp.toutiao.com') || /login/.test(href)) {
      console.log('[toutiao] Not logged in. Please scan QR code...');
      const loggedIn = await waitForLogin(session);
      if (!loggedIn) throw new Error('Login timeout');
    }
    console.log('[toutiao] Logged in.');

    await evaluate(session, `window.location.href = ${JSON.stringify(TOUTIAO_EDITOR_URL)}`);
    await sleep(5000);

    const ready = await waitForExpression(session, `
      !!document.querySelector('textarea[placeholder*="标题"], input[placeholder*="标题"], .ProseMirror, [contenteditable="true"], [role="textbox"]')
    `, 30_000);
    if (!ready) throw new Error('Toutiao editor did not load');

    if (effectiveTitle) {
      console.log('[toutiao] Filling title...');
      await fillTitle(session, effectiveTitle);
      await sleep(500);
    }

    console.log('[toutiao] Focusing editor...');
    const editorFocused = await focusLargestEditor(session);
    if (!editorFocused) throw new Error('Editor not found');
    await sleep(500);

    if (effectiveHtmlFile && fs.existsSync(effectiveHtmlFile)) {
      console.log(`[toutiao] Copying HTML content from: ${effectiveHtmlFile}`);
      await copyHtmlFromBrowser(cdp, effectiveHtmlFile, contentImages);
      await sleep(500);
      console.log('[toutiao] Pasting into editor...');
      await sendPaste(session.cdp, session.sessionId);
      await sleep(2500);

      const editorHasContent = await evaluate<boolean>(session, `
        (function() {
          const roots = Array.from(document.querySelectorAll('.ProseMirror, [contenteditable="true"], [role="textbox"]'));
          return roots.some((root) => (root.innerText || '').trim().length > 0);
        })()
      `);
      if (editorHasContent) console.log('[toutiao] Body content verified OK.');

      if (contentImages.length > 0) {
        console.log(`[toutiao] Inserting ${contentImages.length} images...`);
        for (const img of contentImages) {
          const found = await selectAndReplacePlaceholder(session, img.placeholder);
          if (!found) {
            console.warn(`[toutiao] Placeholder not found: ${img.placeholder}`);
            continue;
          }
          await sleep(300);
          await copyImageToClipboard(img.localPath);
          await sleep(300);
          await pressDeleteKey(session);
          await sleep(200);
          await sendPaste(session.cdp, session.sessionId);
          await sleep(2500);
        }
      }
    }

    if (effectiveSummary) {
      const summaryFilled = await fillSummaryIfPresent(session, effectiveSummary);
      if (summaryFilled) {
        console.log('[toutiao] Summary filled.');
      } else {
        console.log('[toutiao] Summary field not found; skipped.');
      }
    }

    const actionTexts = submit ? ['发布', '发表'] : ['保存草稿', '存草稿', '草稿', '保存'];
    console.log(`[toutiao] ${submit ? 'Publishing' : 'Saving draft'}...`);
    const clicked = await clickButtonByTexts(session, actionTexts);
    if (!clicked) throw new Error(`${submit ? 'Publish' : 'Save draft'} button not found`);
    await sleep(3000);

    if (submit) {
      await clickButtonByTexts(session, ['确认发布', '确认', '发布']);
      await sleep(3000);
    }

    console.log(`[toutiao] ${submit ? 'Publish flow triggered' : 'Draft flow triggered'}. Browser window left open.`);
  } finally {
    cdp.close();
  }
}

function printUsage(): never {
  console.log(`Post article to Toutiao Creator

Usage:
  npx -y bun toutiao-article.ts [options]

Options:
  --title <text>     Article title (auto-extracted from markdown)
  --html <path>      HTML file to paste
  --markdown <path>  Markdown file to convert and post
  --theme <name>     Theme for markdown renderer
  --color <name>     Primary color preset or hex
  --no-cite          Keep ordinary external links inline in markdown mode
  --author <name>    Author name (metadata only)
  --summary <text>   Summary, if the page exposes a summary field
  --submit           Publish instead of saving draft
  --profile <dir>    Chrome profile directory
  --cdp-port <port>  Connect to existing Chrome debug port
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage();

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
    if (arg === '--title' && args[i + 1]) title = args[++i];
    else if (arg === '--html' && args[i + 1]) htmlFile = args[++i];
    else if (arg === '--markdown' && args[i + 1]) markdownFile = args[++i];
    else if (arg === '--theme' && args[i + 1]) theme = args[++i];
    else if (arg === '--color' && args[i + 1]) color = args[++i];
    else if (arg === '--cite') citeStatus = true;
    else if (arg === '--no-cite') citeStatus = false;
    else if (arg === '--author' && args[i + 1]) author = args[++i];
    else if (arg === '--summary' && args[i + 1]) summary = args[++i];
    else if (arg === '--submit') submit = true;
    else if (arg === '--profile' && args[i + 1]) profileDir = args[++i];
    else if (arg === '--cdp-port' && args[i + 1]) cdpPort = parseInt(args[++i]!, 10);
  }

  if (!markdownFile && !htmlFile) {
    console.error('Error: --markdown or --html is required');
    process.exit(1);
  }

  await postArticle({ title: title || '', htmlFile, markdownFile, theme, color, citeStatus, author, summary, submit, profileDir, cdpPort });
}

await main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
