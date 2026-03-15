---
name: post-to-anywhere
description: Publish one article to multiple creator platforms through a shared browser-automation workflow and pluggable platform adapters. Use when the user asks to post or sync the same markdown/HTML article to one or more supported platforms such as WeChat Official Account, Toutiao, Baijiahao, or Zhihu, or when a new publishing platform needs to be added to the shared system.
---

# Post To Anywhere

## Language

Match the user's language.

## Script Directory

Determine this `SKILL.md` directory as `SKILL_DIR`, then use `${SKILL_DIR}/scripts/<name>.ts`.
Resolve `${BUN_X}` runtime: if `bun` installed -> `bun`; else if `npx` available -> `npx -y bun`; else suggest installing bun.

| Script | Purpose |
|--------|---------|
| `scripts/post-anywhere.ts` | Unified entrypoint for one or many platforms |
| `scripts/browser-article.ts` | Generic browser publisher for config-driven platforms |
| `scripts/md-to-article.ts` | Markdown -> paste-ready HTML with image placeholders |
| `scripts/check-permissions.ts` | Verify Chrome, Bun, clipboard, and keystroke support |

## Pre-flight Check

Before first use, suggest:

```bash
${BUN_X} ${SKILL_DIR}/scripts/check-permissions.ts
```

If `scripts/node_modules` is missing, install the vendored renderer dependency first:

```bash
(cd "${SKILL_DIR}/scripts" && ${BUN_X} install)
```

## Workflow

Use this checklist:

```text
Publishing Progress:
- [ ] Step 0: Resolve input article
- [ ] Step 1: Resolve target platforms
- [ ] Step 2: Resolve platform adapter config
- [ ] Step 3: Publish platform by platform
- [ ] Step 4: Report per-platform result
```

### Step 0: Resolve Input Article

Support:

- Markdown files
- HTML files
- Plain text that should first be written to markdown

Prefer markdown input. The shared markdown renderer converts article body into paste-ready HTML and replaces markdown images with placeholders before browser paste.

### Step 1: Resolve Target Platforms

Supported platform ids:

- `wechat`
- `toutiao`
- `baijiahao`
- `zhihu`

Accept common aliases in Chinese or English. `all` expands to every supported platform.

### Step 2: Resolve Platform Adapter Config

All current platforms use the shared browser publisher with per-platform config:

- `wechat`
- `toutiao`
- `baijiahao`
- `zhihu`

The differences between platforms should stay in adapter config whenever possible:

- login/home URL
- editor opening strategy
- title/editor/summary selectors
- save and publish controls

Only split a platform into its own script when config is no longer enough.

### Step 3: Publish

Default to saving drafts. Use `--submit` only when the user explicitly asks to publish.

Commands:

```bash
${BUN_X} ${SKILL_DIR}/scripts/post-anywhere.ts --platform wechat --markdown article.md
${BUN_X} ${SKILL_DIR}/scripts/post-anywhere.ts --platform wechat,toutiao --markdown article.md
${BUN_X} ${SKILL_DIR}/scripts/post-anywhere.ts --platform all --markdown article.md
${BUN_X} ${SKILL_DIR}/scripts/post-anywhere.ts --platform zhihu --html article.html --submit
```

Useful flags:

- `--title <text>`
- `--summary <text>`
- `--theme <name>`
- `--color <name|hex>`
- `--no-cite`
- `--submit`
- `--profile-dir <platform=dir>` repeated per platform

### Step 4: Report

Report:

- Input path
- Target platforms
- Mode: draft or submit
- Which platform configs were used
- Per-platform success or failure
- Whether Chrome windows were left open

## References

- [references/adding-platform.md](references/adding-platform.md) for extending the adapter system
