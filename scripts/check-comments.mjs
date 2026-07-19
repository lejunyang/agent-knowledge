#!/usr/bin/env node
/**
 * 导出 API 注释审计。
 *
 * 这里只提供最低限度的防退化保护，不判断注释文案质量。脚本负责发现缺少相邻 JSDoc 的
 * 导出函数/类；内部函数意图和关键分支的“为什么”仍必须由人工审阅。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/**
 * 例外必须精确指向一个声明，并解释为什么 JSDoc 只会重复签名。
 * 例外应尽量少；新增例外是需要审阅的策略决定，不是快速绕过方式。
 */
const EXCEPTIONS = new Map([
  // 示例 key："src/file.ts#functionName"。当前生产代码没有例外。
]);

/** 递归收集 TypeScript 源码，并排除只用于类型声明的 `.d.ts` shim。 */
function collectTypeScriptFiles(target) {
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) {
    throw new Error(`Comment audit target does not exist: ${target}`);
  }
  if (statSync(resolved).isFile()) {
    return resolved.endsWith(".ts") && !resolved.endsWith(".d.ts") ? [resolved] : [];
  }
  return readdirSync(resolved, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) =>
      collectTypeScriptFiles(path.join(resolved, entry.name))
    );
}

/** 判断声明是否属于模块公开导出面。 */
function isExported(node) {
  return (
    node.modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword ||
        modifier.kind === ts.SyntaxKind.DefaultKeyword
    ) ?? false
  );
}

/** 识别值为可调用对象的导出变量；这类变量在 API 层等同于函数。 */
function exportedCallableVariables(statement) {
  if (!ts.isVariableStatement(statement) || !isExported(statement)) {
    return [];
  }
  return statement.declarationList.declarations.filter(
    (declaration) =>
      declaration.initializer !== undefined &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
  );
}

/** 只接受紧邻声明的 JSDoc，避免把无关文件头误认为函数说明。 */
function hasAdjacentJsDoc(sourceFile, node) {
  const leadingText = sourceFile.text.slice(
    node.getFullStart(),
    node.getStart(sourceFile)
  );
  return /\/\*\*[\s\S]*?\*\/\s*$/.test(leadingText);
}

/** 提取紧邻声明的 JSDoc，供存在性和中文约束共同检查。 */
function adjacentJsDoc(sourceFile, node) {
  const leadingText = sourceFile.text.slice(
    node.getFullStart(),
    node.getStart(sourceFile)
  );
  return leadingText.match(/\/\*\*[\s\S]*?\*\/\s*$/)?.[0] ?? "";
}

/** 生成稳定的文件/符号标识，用于失败输出和显式例外审阅。 */
function declarationIdentity(filePath, sourceFile, node) {
  const relativePath = path
    .relative(repositoryRoot, filePath)
    .split(path.sep)
    .join("/");
  const name =
    node.name && ts.isIdentifier(node.name)
      ? node.name.text
      : node.declarationList
        ? node.declarationList.declarations
            .map((declaration) =>
              ts.isIdentifier(declaration.name) ? declaration.name.text : "anonymous"
            )
            .join(",")
        : "default";
  const line =
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return { key: `${relativePath}#${name}`, relativePath, name, line };
}

/** 审计单个源码文件，返回所有缺少注释的具名函数和导出 class/函数型变量。 */
function auditFile(filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const failures = [];

  for (const statement of sourceFile.statements) {
    const declarations = [];
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.push(statement);
    } else if (ts.isClassDeclaration(statement) && isExported(statement)) {
      declarations.push(statement);
    }
    declarations.push(...exportedCallableVariables(statement));

    for (const declaration of declarations) {
      const identity = declarationIdentity(
        filePath,
        sourceFile,
        ts.isVariableDeclaration(declaration)
          ? declaration
          : declaration
      );
      const jsDoc = adjacentJsDoc(sourceFile, statement);
      if (
        (!hasAdjacentJsDoc(sourceFile, statement) ||
          !/\p{Script=Han}/u.test(jsDoc)) &&
        !EXCEPTIONS.has(identity.key)
      ) {
        failures.push(identity);
      }
    }
  }
  /** 递归检查 class method/constructor；局部 callback 由其外层具名函数说明，不强制逐个注释。 */
  function auditMethods(node) {
    if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const name = ts.isConstructorDeclaration(node)
        ? "constructor"
        : node.name?.getText(sourceFile) ?? "method";
      const jsDoc = adjacentJsDoc(sourceFile, node);
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
        1;
      if (
        (!hasAdjacentJsDoc(sourceFile, node) ||
          !/\p{Script=Han}/u.test(jsDoc)) &&
        !EXCEPTIONS.has(
          `${path.relative(repositoryRoot, filePath).split(path.sep).join("/")}#${name}`
        )
      ) {
        failures.push({
          key: `${filePath}#${name}`,
          relativePath: path
            .relative(repositoryRoot, filePath)
            .split(path.sep)
            .join("/"),
          name,
          line
        });
      }
    }
    ts.forEachChild(node, auditMethods);
  }
  auditMethods(sourceFile);
  return failures;
}

/** 使用 TypeScript scanner 精确检查真实注释，避免把字符串中的 `https://` 误判为注释。 */
function auditCommentLanguage(filePath) {
  const sourceText = readFileSync(filePath, "utf8");
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText
  );
  const relativePath = path
    .relative(repositoryRoot, filePath)
    .split(path.sep)
    .join("/");
  const failures = [];
  let token;
  do {
    token = scanner.scan();
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const comment = scanner.getTokenText();
    if (/[A-Za-z]{3}/.test(comment) && !/\p{Script=Han}/u.test(comment)) {
      const line =
        sourceText.slice(0, scanner.getTokenPos()).split("\n").length;
      failures.push({
        relativePath,
        line,
        preview: comment.replace(/\s+/g, " ").slice(0, 120)
      });
    }
  } while (token !== ts.SyntaxKind.EndOfFileToken);
  return failures;
}

/** 解析 CLI 目标；未指定时默认检查仓库公开 TypeScript 源码树。 */
function resolveTargets(arguments_) {
  const requested = arguments_.length > 0 ? arguments_ : ["src"];
  return [
    ...new Set(
      requested.flatMap((target) =>
        collectTypeScriptFiles(
          path.isAbsolute(target) ? target : path.join(repositoryRoot, target)
        )
      )
    )
  ].sort();
}

const files = resolveTargets(process.argv.slice(2));
const apiFailures = files.flatMap(auditFile);
const languageFailures = files.flatMap(auditCommentLanguage);

if (apiFailures.length > 0) {
  console.error("具名函数或导出 API 缺少相邻的中文 JSDoc：");
  for (const failure of apiFailures) {
    console.error(`- ${failure.relativePath}:${failure.line} ${failure.name}`);
  }
  console.error(
    "请补充说明用途/边界的中文 JSDoc，或为显然 wrapper 添加范围严格且有理由的 EXCEPTIONS 条目。"
  );
}
if (languageFailures.length > 0) {
  console.error("源码注释包含英文-only 文案：");
  for (const failure of languageFailures) {
    console.error(
      `- ${failure.relativePath}:${failure.line} ${failure.preview}`
    );
  }
  console.error("源码注释必须使用中文；必要技术标识符可以保留英文。");
}
if (apiFailures.length === 0 && languageFailures.length === 0) {
  console.log(`注释审计通过：${files.length} 个 TypeScript 文件。`);
} else {
  process.exitCode = 1;
}
