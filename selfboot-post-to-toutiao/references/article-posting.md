# Article Posting (头条文章)

Post markdown articles to Toutiao Creator with browser automation.

## Usage

```bash
(cd ./scripts && ${BUN_X} install)
${BUN_X} ./scripts/toutiao-article.ts --markdown article.md
${BUN_X} ./scripts/toutiao-article.ts --markdown article.md --theme default
${BUN_X} ./scripts/toutiao-article.ts --markdown article.md --no-cite
${BUN_X} ./scripts/toutiao-article.ts --markdown article.md --submit
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `--markdown <path>` | Markdown file to convert and post |
| `--html <path>` | Pre-rendered HTML file |
| `--theme <name>` | Theme for markdown renderer |
| `--color <name|hex>` | Primary color preset or hex |
| `--no-cite` | Keep ordinary external links inline |
| `--title <text>` | Override title |
| `--author <name>` | Metadata author |
| `--summary <text>` | Summary or abstract if page exposes a field |
| `--profile <dir>` | Chrome profile directory |
| `--submit` | Click publish instead of save draft |

## Browser Flow

1. Convert markdown into HTML with image placeholders
2. Launch isolated Chrome with CDP enabled
3. Wait for Toutiao login if needed
4. Open article editor page directly
5. Fill title
6. Paste HTML body into the rich-text editor
7. Replace each placeholder with the actual pasted image
8. Fill summary if a compatible field exists
9. Save draft by default, or publish when `--submit` is passed

## Notes

- Markdown conversion now uses the vendored `scripts/vendor/baoyu-md` package rather than `scripts/md/node_modules`
- This skill is browser-only today; there is no stable Toutiao API mode
- The editor DOM may change over time; if selectors break, patch `scripts/toutiao-article.ts`
- Draft-first is safer. Only use `--submit` when the user explicitly asks to publish
