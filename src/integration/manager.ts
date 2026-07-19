/**
 * integrations 模块负责把 Agent Knowledge 接入不同 agent 产品。
 *
 * 安装器不使用符号链接，也不把整个配置文件视为自己所有：
 * - hooks 只管理 command 中包含 `agent-knowledge hook` 的 handler。
 * - agents/skills/plugin bundle 只管理 manifest 记录的自有路径。
 * - 同名但未被 manifest 管理的资源视为冲突，不覆盖。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type IntegrationProductId = "trae" | "claude-code";
export type IntegrationScope = "user" | "project";
export type IntegrationComponent = "hooks" | "agents" | "skills" | "plugin-bundle";

type JsonObject = Record<string, unknown>;

type ManagedResource = {
  path: string;
  kind: "file" | "directory" | "hooks";
  hash: string;
};

type IntegrationManifest = {
  version: 1;
  product: IntegrationProductId;
  scope: IntegrationScope;
  installedAt: string;
  components: IntegrationComponent[];
  resources: ManagedResource[];
};

export type InstallIntegrationOptions = {
  packageRoot: string;
  product: IntegrationProductId;
  scope: IntegrationScope;
  targetDir?: string;
  components?: readonly IntegrationComponent[];
  platform?: NodeJS.Platform;
};

export type InstallIntegrationResult = {
  product: IntegrationProductId;
  scope: IntegrationScope;
  roots: {
    hooks: string;
    resources: string;
  };
  manifestPath: string;
  managed: Array<ManagedResource & { status: "installed" | "updated" | "unchanged" }>;
  conflicts: string[];
};

export type UninstallIntegrationOptions = {
  product: IntegrationProductId;
  scope: IntegrationScope;
  targetDir?: string;
};

export type UninstallIntegrationResult = {
  removed: string[];
  preserved: string[];
};

export type IntegrationDoctorResult = {
  product: IntegrationProductId;
  scope: IntegrationScope;
  healthy: boolean;
  manifestPath: string;
  checks: Array<{ path: string; status: "ok" | "missing" | "modified" }>;
};

export type IntegrationProduct = {
  id: IntegrationProductId;
  displayName: string;
  components: IntegrationComponent[];
};

const DEFAULT_COMPONENTS: IntegrationComponent[] = ["hooks", "agents", "skills"];
const OWNED_COMMAND_PATTERN = /(?:^|[\s'"])agent-knowledge(?:\.cmd)?\s+hook(?:\s|$)/;
const MANIFEST_FILE = ".agent-knowledge-integration.json";

const PRODUCTS: IntegrationProduct[] = [
  {
    id: "trae",
    displayName: "TRAE",
    components: ["hooks", "agents", "skills", "plugin-bundle"]
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    components: ["hooks", "agents", "skills"]
  }
];

export function listIntegrationProducts(): IntegrationProduct[] {
  return PRODUCTS.map((product) => ({ ...product, components: [...product.components] }));
}

function resolveRoots(
  product: IntegrationProductId,
  scope: IntegrationScope,
  targetDir?: string
): { hooks: string; resources: string } {
  if (targetDir) {
    const resolved = path.resolve(targetDir);
    return { hooks: resolved, resources: resolved };
  }

  if (scope === "project") {
    const root = path.join(process.cwd(), product === "trae" ? ".trae" : ".claude");
    return { hooks: root, resources: root };
  }

  if (product === "trae") {
    const traeHome = path.resolve(process.env.TRAE_HOME ?? path.join(homedir(), ".trae"));
    const traeCliHome = path.resolve(process.env.TRAECLI_HOME ?? path.join(traeHome, "cli"));
    return { hooks: traeCliHome, resources: traeHome };
  }

  const claudeHome = path.join(homedir(), ".claude");
  return { hooks: claudeHome, resources: claudeHome };
}

function manifestPathFor(roots: { resources: string }): string {
  return path.join(roots.resources, MANIFEST_FILE);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function hashPath(target: string): Promise<string> {
  const targetStat = await stat(target);
  if (targetStat.isFile()) {
    return hashText(await readFile(target, "utf8"));
  }

  const entries = await readdir(target, { withFileTypes: true });
  const hashes: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(target, entry.name);
    hashes.push(`${entry.name}:${await hashPath(child)}`);
  }
  return hashText(hashes.join("\n"));
}

async function writeAtomic(target: string, content: string, backup = false): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  if (backup && existsSync(target)) {
    const backupPath = `${target}.agent-knowledge.bak`;
    if (!existsSync(backupPath)) {
      await cp(target, backupPath);
    }
  }
  const temporary = `${target}.agent-knowledge.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

async function readJsonObject(target: string): Promise<JsonObject> {
  if (!existsSync(target)) {
    return {};
  }
  const parsed = JSON.parse(await readFile(target, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in integration config: ${target}`);
  }
  return parsed as JsonObject;
}

function isOwnedHandler(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const command = (value as JsonObject).command;
  return typeof command === "string" && OWNED_COMMAND_PATTERN.test(command);
}

function containsOwnedHook(config: JsonObject): boolean {
  const rawHooks = config.hooks;
  if (!rawHooks || typeof rawHooks !== "object" || Array.isArray(rawHooks)) {
    return false;
  }
  return Object.values(rawHooks as JsonObject).some(
    (rawGroups) =>
      Array.isArray(rawGroups) &&
      rawGroups.some(
        (rawGroup) =>
          rawGroup &&
          typeof rawGroup === "object" &&
          !Array.isArray(rawGroup) &&
          Array.isArray((rawGroup as JsonObject).hooks) &&
          ((rawGroup as JsonObject).hooks as unknown[]).some(isOwnedHandler)
      )
  );
}

function withoutOwnedHooks(config: JsonObject): JsonObject {
  const output = { ...config };
  const rawHooks = config.hooks;
  if (!rawHooks || typeof rawHooks !== "object" || Array.isArray(rawHooks)) {
    return output;
  }

  const hooks: JsonObject = {};
  for (const [event, rawGroups] of Object.entries(rawHooks as JsonObject)) {
    if (!Array.isArray(rawGroups)) {
      hooks[event] = rawGroups;
      continue;
    }

    const groups = rawGroups
      .map((rawGroup) => {
        if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) {
          return rawGroup;
        }
        const group = rawGroup as JsonObject;
        const handlers = Array.isArray(group.hooks) ? group.hooks.filter((handler) => !isOwnedHandler(handler)) : [];
        return handlers.length > 0 ? { ...group, hooks: handlers } : null;
      })
      .filter((group) => group !== null);
    if (groups.length > 0) {
      hooks[event] = groups;
    }
  }
  output.hooks = hooks;
  return output;
}

function mergeManagedHooks(existing: JsonObject, managed: JsonObject): JsonObject {
  const cleaned = withoutOwnedHooks(existing);
  const existingHooks =
    cleaned.hooks && typeof cleaned.hooks === "object" && !Array.isArray(cleaned.hooks)
      ? (cleaned.hooks as JsonObject)
      : {};
  const managedHooks =
    managed.hooks && typeof managed.hooks === "object" && !Array.isArray(managed.hooks)
      ? (managed.hooks as JsonObject)
      : {};
  const hooks: JsonObject = { ...existingHooks };

  for (const [event, groups] of Object.entries(managedHooks)) {
    hooks[event] = [...(Array.isArray(existingHooks[event]) ? existingHooks[event] : []), ...(Array.isArray(groups) ? groups : [])];
  }

  return {
    ...cleaned,
    ...(cleaned.version === undefined && managed.version !== undefined ? { version: managed.version } : {}),
    hooks
  };
}

async function loadManifest(target: string): Promise<IntegrationManifest | null> {
  if (!existsSync(target)) {
    return null;
  }
  return JSON.parse(await readFile(target, "utf8")) as IntegrationManifest;
}

function hookTemplatePath(
  packageRoot: string,
  product: IntegrationProductId,
  platform: NodeJS.Platform
): string {
  if (product === "trae") {
    return path.join(packageRoot, "templates", "trae", platform === "win32" ? "hooks.windows.json" : "hooks.json");
  }
  return path.join(
    packageRoot,
    "templates",
    "claude-code",
    platform === "win32" ? "settings.windows.json" : "settings.json"
  );
}

function hookTargetPath(product: IntegrationProductId, roots: { hooks: string }): string {
  return path.join(roots.hooks, product === "trae" ? "hooks.json" : "settings.json");
}

function agentSourceRoot(packageRoot: string, product: IntegrationProductId): string {
  const productRoot = path.join(packageRoot, "templates", product, "agents");
  return existsSync(productRoot) ? productRoot : path.join(packageRoot, "templates", "trae", "agents");
}

async function copyManagedPath(
  source: string,
  target: string,
  previous: ManagedResource | undefined,
  kind: "file" | "directory"
): Promise<
  | { resource: ManagedResource & { status: "installed" | "updated" | "unchanged" } }
  | { conflict: string }
> {
  const sourceHash = await hashPath(source);
  if (existsSync(target)) {
    if (!previous) {
      if ((await hashPath(target)) === sourceHash) {
        return {
          resource: { path: target, kind, hash: sourceHash, status: "unchanged" }
        };
      }
      return { conflict: target };
    }
    const currentHash = await hashPath(target);
    if (currentHash !== previous.hash && currentHash !== sourceHash) {
      return { conflict: target };
    }
    if (currentHash === sourceHash) {
      return {
        resource: { path: target, kind, hash: sourceHash, status: "unchanged" }
      };
    }
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: kind === "directory" });
    return {
      resource: { path: target, kind, hash: sourceHash, status: "updated" }
    };
  }

  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: kind === "directory" });
  return {
    resource: { path: target, kind, hash: sourceHash, status: "installed" }
  };
}

export async function installIntegration(options: InstallIntegrationOptions): Promise<InstallIntegrationResult> {
  const product = PRODUCTS.find((item) => item.id === options.product);
  if (!product) {
    throw new Error(`Unsupported integration product: ${options.product}`);
  }
  const components = [...new Set(options.components ?? DEFAULT_COMPONENTS)];
  for (const component of components) {
    if (!product.components.includes(component)) {
      throw new Error(`${options.product} does not support component: ${component}`);
    }
  }

  const roots = resolveRoots(options.product, options.scope, options.targetDir);
  const manifestPath = manifestPathFor(roots);
  const previousManifest = await loadManifest(manifestPath);
  const previousByPath = new Map(previousManifest?.resources.map((resource) => [resource.path, resource]) ?? []);
  const managed: InstallIntegrationResult["managed"] = [];
  const conflicts: string[] = [];

  if (components.includes("hooks")) {
    const target = hookTargetPath(options.product, roots);
    const existing = await readJsonObject(target);
    const template = await readJsonObject(
      hookTemplatePath(path.resolve(options.packageRoot), options.product, options.platform ?? process.platform)
    );
    const merged = mergeManagedHooks(existing, template);
    const content = stableJson(merged);
    const previous = previousByPath.get(target);
    const status =
      existsSync(target) && hashText(await readFile(target, "utf8")) === hashText(content)
        ? "unchanged"
        : previous
          ? "updated"
          : "installed";
    await writeAtomic(target, content, true);
    managed.push({ path: target, kind: "hooks", hash: hashText(content), status });
  }

  if (components.includes("agents")) {
    const sourceRoot = agentSourceRoot(path.resolve(options.packageRoot), options.product);
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".md"))) {
      const target = path.join(roots.resources, "agents", entry.name);
      const outcome = await copyManagedPath(
        path.join(sourceRoot, entry.name),
        target,
        previousByPath.get(target),
        "file"
      );
      if ("conflict" in outcome) {
        conflicts.push(outcome.conflict);
      } else {
        managed.push(outcome.resource);
      }
    }
  }

  if (components.includes("skills")) {
    const sourceRoot = path.join(path.resolve(options.packageRoot), ".trae", "skills");
    if (existsSync(sourceRoot)) {
      const entries = await readdir(sourceRoot, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isDirectory())) {
        const target = path.join(roots.resources, "skills", entry.name);
        const outcome = await copyManagedPath(
          path.join(sourceRoot, entry.name),
          target,
          previousByPath.get(target),
          "directory"
        );
        if ("conflict" in outcome) {
          conflicts.push(outcome.conflict);
        } else {
          managed.push(outcome.resource);
        }
      }
    }
  }

  if (components.includes("plugin-bundle")) {
    const source = path.join(path.resolve(options.packageRoot), "templates", "trae", "plugin");
    const target = path.join(roots.resources, "plugins", "agent-knowledge");
    const outcome = await copyManagedPath(source, target, previousByPath.get(target), "directory");
    if ("conflict" in outcome) {
      conflicts.push(outcome.conflict);
    } else {
      if ((options.platform ?? process.platform) === "win32") {
        const windowsHooks = path.join(source, "hooks", "hooks.windows.json");
        if (existsSync(windowsHooks)) {
          await cp(windowsHooks, path.join(target, "hooks", "hooks.json"), { force: true });
          outcome.resource.hash = await hashPath(target);
          outcome.resource.status =
            previousByPath.get(target)?.hash === outcome.resource.hash ? "unchanged" : outcome.resource.status;
        }
      }
      managed.push(outcome.resource);
    }
  }

  const preservedPrevious = previousManifest?.resources.filter(
    (resource) => !managed.some((current) => current.path === resource.path)
  ) ?? [];
  const manifest: IntegrationManifest = {
    version: 1,
    product: options.product,
    scope: options.scope,
    installedAt: new Date().toISOString(),
    components,
    resources: [
      ...preservedPrevious,
      ...managed.map(({ status: _status, ...resource }) => resource)
    ]
  };
  await writeAtomic(manifestPath, stableJson(manifest));

  return {
    product: options.product,
    scope: options.scope,
    roots,
    manifestPath,
    managed,
    conflicts
  };
}

export async function uninstallIntegration(
  options: UninstallIntegrationOptions
): Promise<UninstallIntegrationResult> {
  const roots = resolveRoots(options.product, options.scope, options.targetDir);
  const manifestPath = manifestPathFor(roots);
  const manifest = await loadManifest(manifestPath);
  if (!manifest) {
    return { removed: [], preserved: [] };
  }

  const removed: string[] = [];
  const preserved: string[] = [];
  for (const resource of manifest.resources) {
    if (!existsSync(resource.path)) {
      continue;
    }
    if (resource.kind === "hooks") {
      const config = withoutOwnedHooks(await readJsonObject(resource.path));
      await writeAtomic(resource.path, stableJson(config), true);
      removed.push(resource.path);
      continue;
    }
    if ((await hashPath(resource.path)) !== resource.hash) {
      preserved.push(resource.path);
      continue;
    }
    await rm(resource.path, { recursive: true, force: true });
    removed.push(resource.path);
  }

  await rm(manifestPath, { force: true });
  return { removed, preserved };
}

export async function doctorIntegration(
  options: UninstallIntegrationOptions
): Promise<IntegrationDoctorResult> {
  const roots = resolveRoots(options.product, options.scope, options.targetDir);
  const manifestPath = manifestPathFor(roots);
  const manifest = await loadManifest(manifestPath);
  if (!manifest) {
    return {
      product: options.product,
      scope: options.scope,
      healthy: false,
      manifestPath,
      checks: []
    };
  }

  const checks: IntegrationDoctorResult["checks"] = [];
  for (const resource of manifest.resources) {
    if (!existsSync(resource.path)) {
      checks.push({ path: resource.path, status: "missing" });
      continue;
    }
    if (resource.kind === "hooks") {
      checks.push({
        path: resource.path,
        status: containsOwnedHook(await readJsonObject(resource.path)) ? "ok" : "modified"
      });
      continue;
    }
    checks.push({
      path: resource.path,
      status: (await hashPath(resource.path)) === resource.hash ? "ok" : "modified"
    });
  }

  return {
    product: options.product,
    scope: options.scope,
    healthy: checks.length > 0 && checks.every((check) => check.status === "ok"),
    manifestPath,
    checks
  };
}
