/**
 * Policy store 只管理 Git 可追踪的 reviewed YAML。
 *
 * 它不执行 Policy、不修改 query，也不读取 `.memory` proposal。写入使用 `wx` 和 0600，
 * 拒绝覆盖已有 ID，确保人工审阅历史不会被后台任务静默替换。
 */
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { resolveWorkspacePath } from "../core/paths.js";
import {
  MemoryUsePolicySchema,
  type MemoryUsePolicy,
  type MemoryUsePolicyInput
} from "./types.js";

const POLICY_README = `# Memory Use Policies

This directory contains reviewed, Git-tracked shadow policies.

- \`retrieval/\`: Retrieval Lessons for routing, preference, suppression, freshness, and abstention.
- \`reasoning/\`: Reasoning Policies for deterministic evidence and safety checks.

P0-P2 policies are shadow-only. They do not alter normal query or Hook behavior.
Runtime activation requires the separate P3 design, eval gates, rollback, and kill switch.
`;

/** 只创建缺失文件，不能覆盖用户对 Policy 数据仓库的说明。 */
async function writeIfMissing(target: string, content: string): Promise<void> {
  try {
    await writeFile(target, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return;
    }
    throw error;
  }
}

/** 初始化 Policy Git 目录；不创建 proposal、simulation 或 active runtime 配置。 */
export async function initializePolicyWorkspace(rootDir: string): Promise<void> {
  for (const directory of ["policies/retrieval", "policies/reasoning"]) {
    await mkdir(resolveWorkspacePath(rootDir, directory), {
      recursive: true,
      mode: 0o700
    });
  }
  await writeIfMissing(
    resolveWorkspacePath(rootDir, "policies", "README.md"),
    POLICY_README
  );
}

/** 返回 Policy 的固定路径；kind 决定目录，ID 只能来自严格 schema。 */
export function getPolicyPath(
  rootDir: string,
  policy: Pick<MemoryUsePolicy, "id" | "kind">
): string {
  return resolveWorkspacePath(
    rootDir,
    "policies",
    policy.kind === "retrieval_lesson" ? "retrieval" : "reasoning",
    `${policy.id}.yaml`
  );
}

/** 校验外部 YAML 文件，不写 workspace。 */
export async function validatePolicyFile(
  filePath: string
): Promise<MemoryUsePolicy> {
  return MemoryUsePolicySchema.parse(
    yaml.load(await readFile(path.resolve(filePath), "utf8"))
  );
}

/** 写入新的 reviewed shadow Policy；已有同 ID 文件必须显式走未来更新流程。 */
export async function writePolicy(
  rootDir: string,
  rawPolicy: MemoryUsePolicyInput
): Promise<string> {
  const policy = MemoryUsePolicySchema.parse(rawPolicy);
  await initializePolicyWorkspace(rootDir);
  const target = getPolicyPath(rootDir, policy);
  if (existsSync(target)) {
    throw new Error(`Policy already exists and cannot be overwritten: ${policy.id}`);
  }
  await writeFile(target, yaml.dump(policy, { noRefs: true, lineWidth: 100 }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await chmod(target, 0o600);
  return target;
}

/** 按 ID 读取 Policy；相同 ID 同时出现在两类目录时明确失败。 */
export async function readPolicy(
  rootDir: string,
  id: string
): Promise<MemoryUsePolicy | null> {
  const matches: MemoryUsePolicy[] = [];
  for (const kind of ["retrieval_lesson", "reasoning_policy"] as const) {
    const target = getPolicyPath(rootDir, { id, kind });
    if (existsSync(target)) {
      matches.push(
        MemoryUsePolicySchema.parse(
          yaml.load(await readFile(target, "utf8"))
        )
      );
    }
  }
  if (matches.length > 1) {
    throw new Error(`Policy ID is duplicated across policy kinds: ${id}`);
  }
  return matches[0] ?? null;
}

/** 列出全部 reviewed Policy，按 priority 降序、ID 升序稳定排序。 */
export async function listPolicies(rootDir: string): Promise<MemoryUsePolicy[]> {
  const policies: MemoryUsePolicy[] = [];
  for (const directory of ["policies/retrieval", "policies/reasoning"]) {
    const absolute = resolveWorkspacePath(rootDir, directory);
    if (!existsSync(absolute)) {
      continue;
    }
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
        continue;
      }
      policies.push(
        MemoryUsePolicySchema.parse(
          yaml.load(await readFile(path.join(absolute, entry.name), "utf8"))
        )
      );
    }
  }
  return policies.sort(
    (left, right) =>
      right.priority - left.priority || left.id.localeCompare(right.id)
  );
}
