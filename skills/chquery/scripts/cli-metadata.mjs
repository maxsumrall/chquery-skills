import { readFile } from "node:fs/promises";

import { getCapabilities } from "../lib/capabilities.js";

let packageMetadata;

async function readPackageMetadata() {
  packageMetadata ||= readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse);
  return packageMetadata;
}

export async function getCliVersion() {
  const metadata = await readPackageMetadata();
  if (typeof metadata.version !== "string" || !metadata.version) throw new TypeError("Packaged CH Query version is missing.");
  return metadata.version;
}

export async function getCliCapabilities(options = {}) {
  const metadata = await readPackageMetadata();
  return getCapabilities({ toolVersion: await getCliVersion(), build: metadata.gitHead ?? null, ...options });
}
