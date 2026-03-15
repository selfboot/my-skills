import { getDefaultProfileDir } from "./cdp.ts";

export type PlatformId = "wechat" | "toutiao" | "baijiahao" | "zhihu";

export interface CommonPublishOptions {
  markdownFile?: string;
  htmlFile?: string;
  title?: string;
  summary?: string;
  author?: string;
  theme?: string;
  color?: string;
  citeStatus?: boolean;
  submit?: boolean;
  profileDir?: string;
  cdpPort?: number;
}

export type OpenStrategy = "direct" | "wechat-menu-article" | "click-text";
export type InputMode = "insertText" | "setValue";

export interface GenericPlatformDefinition {
  id: PlatformId;
  displayName: string;
  mode: "generic";
  homeUrl: string;
  editorUrl: string;
  urlPattern: string;
  loginKeywords: RegExp;
  loggedInUrlIncludes?: string;
  openStrategy?: OpenStrategy;
  openMenuText?: string;
  openMenuSelector?: string;
  titleSelectors: string[];
  titleInputMode?: InputMode;
  clearTitleBeforeFill?: boolean;
  authorSelectors?: string[];
  authorInputMode?: InputMode;
  editorSelectors: string[];
  clearBodyBeforePaste?: boolean;
  summarySelectors: string[];
  summaryInputMode?: InputMode;
  bodyTextSelector?: string;
  saveDraftTexts?: string[];
  saveDraftSelector?: string;
  autoSaveDraft?: boolean;
  publishTexts?: string[];
  publishSelector?: string;
  confirmPublishTexts?: string[];
  confirmPublishSelector?: string;
  profileDir: string;
}

const genericPlatforms: Record<PlatformId, GenericPlatformDefinition> = {
  wechat: {
    id: "wechat",
    displayName: "WeChat Official Account",
    mode: "generic",
    homeUrl: "https://mp.weixin.qq.com/",
    editorUrl: "https://mp.weixin.qq.com/",
    urlPattern: "mp.weixin.qq.com",
    loginKeywords: /登录|扫码|微信公众平台/,
    loggedInUrlIncludes: "/cgi-bin/",
    openStrategy: "wechat-menu-article",
    openMenuText: "文章",
    titleSelectors: ["#title"],
    titleInputMode: "setValue",
    authorSelectors: ["#author"],
    authorInputMode: "setValue",
    editorSelectors: [".ProseMirror"],
    summarySelectors: ["#js_description"],
    summaryInputMode: "setValue",
    bodyTextSelector: ".ProseMirror",
    saveDraftSelector: "#js_submit button",
    publishTexts: ["发布"],
    profileDir: getDefaultProfileDir("wechat"),
  },
  toutiao: {
    id: "toutiao",
    displayName: "Toutiao Creator",
    mode: "generic",
    homeUrl: "https://mp.toutiao.com/",
    editorUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
    urlPattern: "mp.toutiao.com",
    loginKeywords: /登录|登录后|扫码/,
    titleSelectors: [
      'textarea[placeholder*="标题"]',
      'input[placeholder*="标题"]',
      "textarea",
      'input[type="text"]',
    ],
    titleInputMode: "insertText",
    editorSelectors: [".ProseMirror", '[contenteditable="true"]', '[role="textbox"]'],
    summarySelectors: [
      'textarea[placeholder*="摘要"]',
      'textarea[placeholder*="简介"]',
      'input[placeholder*="摘要"]',
    ],
    summaryInputMode: "setValue",
    saveDraftTexts: ["保存草稿", "存草稿", "草稿", "保存"],
    publishTexts: ["发布", "发表"],
    confirmPublishTexts: ["确认发布", "确认", "发布"],
    profileDir: getDefaultProfileDir("toutiao"),
  },
  baijiahao: {
    id: "baijiahao",
    displayName: "Baijiahao",
    mode: "generic",
    homeUrl: "https://baijiahao.baidu.com/builder/rc/home",
    editorUrl: "https://baijiahao.baidu.com/builder/rc/edit",
    urlPattern: "baijiahao.baidu.com",
    loginKeywords: /登录|注册|扫码|手机号|验证/,
    loggedInUrlIncludes: "/builder/rc/",
    openStrategy: "click-text",
    openMenuSelector: "#home-publish-btn",
    openMenuText: "发布图文",
    titleSelectors: [
      '#newsTextArea [contenteditable="true"]',
      '#bjhNewsTitle [contenteditable="true"]',
      'textarea[placeholder*="标题"]',
      'input[placeholder*="标题"]',
      'input[data-testid*="title"]',
    ],
    titleInputMode: "insertText",
    clearTitleBeforeFill: true,
    editorSelectors: [
      "iframe#ueditor_0",
      ".ProseMirror",
      '[contenteditable="true"]',
      '[role="textbox"]',
      ".ql-editor",
      ".public-DraftEditor-content",
    ],
    clearBodyBeforePaste: true,
    summarySelectors: [
      "#abstract",
      'textarea[placeholder*="摘要"]',
      'textarea[placeholder*="简介"]',
      'input[placeholder*="摘要"]',
    ],
    summaryInputMode: "setValue",
    saveDraftSelector: ".op-list-right .op-btn-outter-content:first-child button",
    saveDraftTexts: ["保存", "草稿", "存草稿", "保存草稿"],
    publishTexts: ["发布", "发表"],
    confirmPublishTexts: ["确认发布", "确认", "发布"],
    profileDir: getDefaultProfileDir("baijiahao"),
  },
  zhihu: {
    id: "zhihu",
    displayName: "Zhihu Column",
    mode: "generic",
    homeUrl: "https://www.zhihu.com/creator",
    editorUrl: "https://zhuanlan.zhihu.com/write",
    urlPattern: "zhihu.com",
    loginKeywords: /登录|注册|扫码登录|手机号|密码/,
    titleSelectors: [
      'textarea[placeholder*="标题"]',
      'input[placeholder*="标题"]',
      'input[data-testid*="title"]',
    ],
    titleInputMode: "insertText",
    editorSelectors: [
      ".ProseMirror",
      '[contenteditable="true"]',
      '[role="textbox"]',
      ".DraftEditor-editorContainer",
    ],
    summarySelectors: [
      'textarea[placeholder*="摘要"]',
      'textarea[placeholder*="简介"]',
      'input[placeholder*="摘要"]',
    ],
    summaryInputMode: "setValue",
    autoSaveDraft: true,
    publishTexts: ["发布", "发表文章", "发表"],
    confirmPublishTexts: ["确认发布", "确认", "发布"],
    profileDir: getDefaultProfileDir("zhihu"),
  },
};

const aliasToPlatform: Record<string, PlatformId> = {
  wechat: "wechat",
  wx: "wechat",
  gzh: "wechat",
  "公众号": "wechat",
  "微信公众号": "wechat",
  toutiao: "toutiao",
  tt: "toutiao",
  "头条": "toutiao",
  "今日头条": "toutiao",
  baijiahao: "baijiahao",
  bjh: "baijiahao",
  "百家号": "baijiahao",
  zhihu: "zhihu",
  "知乎": "zhihu",
};

export const supportedPlatforms: PlatformId[] = ["wechat", "toutiao", "baijiahao", "zhihu"];

export function parsePlatformList(input: string): PlatformId[] {
  const parts = input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("At least one platform is required");
  }

  const resolved = new Set<PlatformId>();
  for (const part of parts) {
    if (part === "all") {
      supportedPlatforms.forEach((platform) => resolved.add(platform));
      continue;
    }
    const id = aliasToPlatform[part.toLowerCase()] ?? aliasToPlatform[part];
    if (!id) throw new Error(`Unsupported platform: ${part}`);
    resolved.add(id);
  }

  return Array.from(resolved);
}

export function getPlatformDefinition(platform: PlatformId): GenericPlatformDefinition {
  return genericPlatforms[platform];
}
