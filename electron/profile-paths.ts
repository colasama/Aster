import { join } from "node:path";

const DEVELOPMENT_PROFILE_NAME = "Aster Development";

/** Keep source checkouts isolated from an installed Aster profile and Chromium cache. */
export function developmentProfileDirectory(
  appDataDirectory: string,
  packaged: boolean,
  hasExplicitUserDataDirectory: boolean,
): string | undefined {
  if (packaged || hasExplicitUserDataDirectory) return undefined;
  return join(appDataDirectory, DEVELOPMENT_PROFILE_NAME);
}
