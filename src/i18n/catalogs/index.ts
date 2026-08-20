import { commonEn } from "./common.en";
import { commonZh } from "./common.zh";
import { inspectorEn } from "./inspector.en";
import { inspectorZh } from "./inspector.zh";
import { topBarEn } from "./topbar.en";
import { topBarZh } from "./topbar.zh";
import { workspaceEn } from "./workspace.en";
import { workspaceZh } from "./workspace.zh";

export const enUS = {
  ...commonEn,
  ...inspectorEn,
  ...topBarEn,
  ...workspaceEn,
} as const;

export type MessageCatalog = typeof enUS;
export type MessageKey = keyof MessageCatalog;

export const zhCN = {
  ...commonZh,
  ...inspectorZh,
  ...topBarZh,
  ...workspaceZh,
} as const satisfies Record<MessageKey, string>;

export const catalogs = {
  "en-US": enUS,
  "zh-CN": zhCN,
} as const;
