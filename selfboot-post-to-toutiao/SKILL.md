---
name: selfboot-post-to-toutiao
description: Posts articles to Toutiao Creator (今日头条创作者平台) via Chrome CDP browser automation. Supports markdown or HTML input, saves drafts by default, and can optionally trigger publish. Use when user mentions "发头条", "发布头条文章", "今日头条", "Toutiao", or asks to post an article to Toutiao.
---

# Post to Toutiao Creator

## Language

Match the user's language.

## Script Directory

Determine this SKILL.md directory as `SKILL_DIR`, then use `${SKILL_DIR}/scripts/<name>.ts`.
Resolve `${BUN_X}` runtime: if `bun` installed -> `bun`; else if `npx` available -> `npx -y bun`; else suggest installing bun.

| Script | Purpose |
|--------|---------|
| `scripts/toutiao-article.ts` | Post markdown/HTML articles to Toutiao by browser automation |
| `scripts/md-to-toutiao.ts` | Markdown -> paste-ready HTML with image placeholders |
| `scripts/check-permissions.ts` | Verify Chrome, profile, clipboard, and keystroke permissions |

## Preferences (EXTEND.md)

Check EXTEND.md in this order:

```bash
test -f .selfboot-skills/selfboot-post-to-toutiao/EXTEND.md && echo "project"
test -f "$HOME/.selfboot-skills/selfboot-post-to-toutiao/EXTEND.md" && echo "user"
```

Supported keys:

| Key | Default | Use |
|-----|---------|-----|
| `default_theme` | `default` | Markdown renderer theme |
| `default_color` | empty | Markdown renderer primary color |
| `default_author` | empty | Fallback article author |
| `chrome_profile_path` | skill default | Browser profile path |
| `default_publish_mode` | `draft` | `draft` or `submit` |

Recommended EXTEND.md:

```md
default_theme: default
default_color: red
default_author: selfboot
default_publish_mode: draft
chrome_profile_path: /path/to/profile
```

## Pre-flight Check

Before first use, suggest:

```bash
${BUN_X} ${SKILL_DIR}/scripts/check-permissions.ts
```

If it fails, help the user fix Chrome, Accessibility, clipboard, or paste-keystroke permissions.

If `scripts/node_modules` is missing, install the vendored renderer dependency:

```bash
(cd "${SKILL_DIR}/scripts" && ${BUN_X} install)
```

## Workflow

Use this checklist:

```text
Publishing Progress:
- [ ] Step 0: Load preferences
- [ ] Step 1: Determine input type
- [ ] Step 2: Resolve metadata
- [ ] Step 3: Publish by browser automation
- [ ] Step 4: Report result
```

### Step 0: Load Preferences

Read project-level or user-level EXTEND.md if present. Resolve:

- `default_theme` fallback `default`
- `default_color` optional
- `default_author`
- `default_publish_mode` fallback `draft`
- `chrome_profile_path`

### Step 1: Determine Input Type

| Input Type | Detection | Action |
|------------|-----------|--------|
| HTML file | Path ends with `.html`, file exists | Post directly |
| Markdown file | Path ends with `.md`, file exists | Use browser posting with internal conversion |
| Plain text | Not a file path | Save to markdown first, then continue |

For plain text input:

1. Create `post-to-toutiao/yyyy-MM-dd/`
2. Save the article as markdown
3. Continue as markdown

### Step 2: Resolve Metadata

Resolve in this order:

1. CLI flags
2. Frontmatter
3. EXTEND.md
4. Generated fallback

Rules:

- Title: first H1/H2 or first sentence if missing
- Summary: first paragraph, truncated to about 120 chars if missing
- Author: optional; use default if set

### Step 3: Publish by Browser Automation

Use browser automation by default. This skill does not implement a stable API mode.

Important:

- Pass markdown directly to `scripts/toutiao-article.ts`; do not pre-convert unless the user already has HTML
- The script opens Chrome with an isolated profile and connects through CDP
- Markdown rendering uses the vendored `baoyu-md` package under `scripts/vendor/baoyu-md`
- If not logged in, it will pause for QR-code login
- It opens the Toutiao article editor page directly
- It fills title, pastes HTML body, replaces image placeholders with actual pasted images, fills summary if possible, then clicks `保存草稿`
- Use `--submit` only when the user explicitly asks to publish, not merely save a draft

Commands:

```bash
${BUN_X} ${SKILL_DIR}/scripts/toutiao-article.ts --markdown article.md --theme default
${BUN_X} ${SKILL_DIR}/scripts/toutiao-article.ts --html article.html
${BUN_X} ${SKILL_DIR}/scripts/toutiao-article.ts --markdown article.md --submit
```

Markdown notes:

- Ordinary external links are converted to bottom citations by default
- Use `--no-cite` only if the user explicitly wants inline links preserved

### Step 4: Report Result

Report:

- Input path
- Method: Browser automation
- Mode: Draft or Submit
- Title
- Summary
- Whether login was required
- Whether the browser window was left open

## References

- [references/article-posting.md](references/article-posting.md) for parameters and the browser posting flow
