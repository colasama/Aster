import { aiPluginsEn } from "./ai-plugins.en";
import { aiPluginsZh } from "./ai-plugins.zh";
import { commonEn } from "./common.en";
import { commonZh } from "./common.zh";
import { controlsEn } from "./controls.en";
import { controlsZh } from "./controls.zh";
import { errorsEn } from "./errors.en";
import { errorsZh } from "./errors.zh";
import { inspectorEn } from "./inspector.en";
import { inspectorZh } from "./inspector.zh";
import { panelsEn } from "./panels.en";
import { panelsZh } from "./panels.zh";
import { scene3dEn } from "./scene3d.en";
import { scene3dZh } from "./scene3d.zh";
import { timelineEn } from "./timeline.en";
import { timelineZh } from "./timeline.zh";
import { topBarEn } from "./topbar.en";
import { topBarZh } from "./topbar.zh";
import { workspaceEn } from "./workspace.en";
import { workspaceZh } from "./workspace.zh";

export const enUS = {
  ...commonEn,
  ...aiPluginsEn,
  ...controlsEn,
  ...errorsEn,
  ...inspectorEn,
  ...panelsEn,
  ...scene3dEn,
  ...timelineEn,
  ...topBarEn,
  ...workspaceEn,
} as const;

export type MessageCatalog = typeof enUS;
export type MessageKey = keyof MessageCatalog;

export const zhCN = {
  ...commonZh,
  ...aiPluginsZh,
  ...controlsZh,
  ...errorsZh,
  ...inspectorZh,
  ...panelsZh,
  ...scene3dZh,
  ...timelineZh,
  ...topBarZh,
  ...workspaceZh,
} as const satisfies Record<MessageKey, string>;

export const catalogs = {
  "en-US": enUS,
  "zh-CN": zhCN,
} as const;
