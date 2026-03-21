import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parsePlatformList, type CommonPublishOptions, type PlatformId } from "./platforms.ts";

interface PublishResult {
  platform: PlatformId;
  ok: boolean;
  adapter: "generic";
  message: string;
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

function buildSharedArgs(options: CommonPublishOptions): string[] {
  const args: string[] = [];
  if (options.markdownFile) args.push("--markdown", options.markdownFile);
  if (options.htmlFile) args.push("--html", options.htmlFile);
  if (options.title) args.push("--title", options.title);
  if (options.author) args.push("--author", options.author);
  if (options.summary) args.push("--summary", options.summary);
  if (options.theme) args.push("--theme", options.theme);
  if (options.color) args.push("--color", options.color);
  if (options.citeStatus === false) args.push("--no-cite");
  if (options.submit) args.push("--submit");
  if (options.profileDir) args.push("--profile", options.profileDir);
  if (options.cdpPort != null) args.push("--cdp-port", String(options.cdpPort));
  return args;
}

function runScript(scriptPath: string, args: string[]): { ok: boolean; message: string } {
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, message: `Script not found: ${scriptPath}` };
  }
  const result = spawnSync("npx", ["-y", "bun", scriptPath, ...args], {
    stdio: "inherit",
  });
  return {
    ok: result.status === 0,
    message: result.status === 0 ? "Success" : `Exited with status ${result.status ?? -1}`,
  };
}

function runPlatform(platform: PlatformId, options: CommonPublishOptions): PublishResult {
  const sharedArgs = buildSharedArgs(options);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const genericScript = path.join(__dirname, "browser-article.ts");
  const result = runScript(genericScript, ["--platform", platform, ...sharedArgs]);
  return {
    platform,
    ok: result.ok,
    adapter: "generic",
    message: result.message,
  };
}

function printUsage(): never {
  console.log(`Publish one article to one or many platforms

Usage:
  npx -y bun post-anywhere.ts --platform <list> [options]

Options:
  --platform <list>         Comma-separated platforms or all
  --markdown <path>         Markdown article file
  --html <path>             HTML article file
  --title <text>            Optional title override
  --author <text>           Optional author override
  --summary <text>          Optional summary override
  --theme <name>            Theme for markdown renderer
  --color <name|hex>        Primary color preset or hex
  --no-cite                 Keep ordinary external links inline
  --submit                  Publish instead of saving draft
  --profile-dir <kv>        Per-platform profile directory, e.g. zhihu=/tmp/zhihu-profile
  --cdp-port <port>         Reuse an existing Chrome debug port
  --help                    Show this help

Examples:
  npx -y bun post-anywhere.ts --platform wechat --markdown article.md
  npx -y bun post-anywhere.ts --platform wechat,toutiao --markdown article.md
  npx -y bun post-anywhere.ts --platform all --markdown article.md
  npx -y bun post-anywhere.ts --platform zhihu --html article.html --submit
`);
  process.exit(0);
}

async function main(): Promise<void> {
  ensureScriptDependencies();

  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
  }

  let platformInput: string | undefined;
  let markdownFile: string | undefined;
  let htmlFile: string | undefined;
  let title: string | undefined;
  let author: string | undefined;
  let summary: string | undefined;
  let theme: string | undefined;
  let color: string | undefined;
  let citeStatus = true;
  let submit = false;
  let cdpPort: number | undefined;
  const profileDirs = new Map<PlatformId, string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--platform" && args[i + 1]) platformInput = args[++i];
    else if (arg === "--markdown" && args[i + 1]) markdownFile = args[++i];
    else if (arg === "--html" && args[i + 1]) htmlFile = args[++i];
    else if (arg === "--title" && args[i + 1]) title = args[++i];
    else if (arg === "--author" && args[i + 1]) author = args[++i];
    else if (arg === "--summary" && args[i + 1]) summary = args[++i];
    else if (arg === "--theme" && args[i + 1]) theme = args[++i];
    else if (arg === "--color" && args[i + 1]) color = args[++i];
    else if (arg === "--cite") citeStatus = true;
    else if (arg === "--no-cite") citeStatus = false;
    else if (arg === "--submit") submit = true;
    else if (arg === "--cdp-port" && args[i + 1]) cdpPort = parseInt(args[++i]!, 10);
    else if (arg === "--profile-dir" && args[i + 1]) {
      const [platform, dir] = args[++i]!.split("=", 2);
      if (!platform || !dir) throw new Error(`Invalid --profile-dir value: ${args[i]}`);
      profileDirs.set(platform as PlatformId, dir);
    }
  }

  if (!platformInput) {
    console.error("Error: --platform is required");
    process.exit(1);
  }
  if (!markdownFile && !htmlFile) {
    console.error("Error: --markdown or --html is required");
    process.exit(1);
  }

  const platforms = parsePlatformList(platformInput);
  const results: PublishResult[] = [];

  for (const platform of platforms) {
    const result = runPlatform(platform, {
      markdownFile,
      htmlFile,
      title,
      author,
      summary,
      theme,
      color,
      citeStatus,
      submit,
      cdpPort,
      profileDir: profileDirs.get(platform),
    });
    results.push(result);
  }

  console.log("\n[post-to-anywhere] Summary");
  for (const result of results) {
    console.log(`- ${result.platform}: ${result.ok ? "OK" : "FAIL"} (${result.adapter}) ${result.message}`);
  }

  if (results.some((item) => !item.ok)) {
    process.exit(1);
  }
}

await main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
