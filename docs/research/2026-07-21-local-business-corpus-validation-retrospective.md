# 本地业务语料构建与检索验证复盘

## 范围

本轮从 5 个用户指定的飞书 Wiki 入口递归读取内嵌文档，建立本项目 ignored 的真实业务知识库，并用真实问题循环验证检索链路。

最终本地数据：

- 成功读取文档：656。
- 唯一标题：625。
- 重复标题记录：31。
- 嵌入资源：864。
- 失败引用：2242，主要为无权限、资源失效和旧接口错误。
- 递归状态：`complete=true`、`pending=0`。
- 正式 source：656。
- 可检索精炼知识：33，其中既有 24、新增 9。

## 为什么拉取 656 篇，只新增 9 条精炼知识

### 1. Source 与可检索知识职责不同

656 篇完整正文保存为 `type: source`，目的是：

- 保留可审计证据。
- 后续重新整理时不必重复访问飞书。
- 给 graph/source provenance 提供稳定节点。
- 允许上游文档更新后按稳定 ID 刷新。

Source 不进入 FTS 或 embedding。把长文直接当检索知识会导致标题、历史方案、表格、人员、测试材料和过期细节淹没具体答案。

### 2. 递归引用扩大了主题边界

入口文档引用了账号、权限、认证、稳定性、前端工具、事故规范等外围资料。技术上这些链接都属于“可达图”，但不都属于当前“商家中心核心知识”目标。

本轮没有在抓取前设置 allowlist/domain depth，因此先完整保留可访问 source；正式知识只选择与当前目标直接相关、稳定、可复用且能建立评测问题的内容。

### 3. 不能机械地“一篇文档等于一条知识”

一篇文档可能：

- 与其他文档重复或只是 Wiki/Doc 双重引用。
- 同时包含多个独立事实和 SOP。
- 主要是项目排期、人员名单、测试账号、截图或历史讨论。
- 已被既有 24 条知识覆盖。
- 包含过期版本、待确认方案或冲突结论。

把 625 个唯一标题机械转成 625 条 active 会制造重复、冲突和时效风险。正确流程是按主题分批聚类、去重、抽取、评测和人工审阅。

### 4. 9 条是“首批流程验证集”，不是语料抽取上限

新增 9 条覆盖：

- PC 微前端动态装载。
- 微前端共享状态与依赖单例。
- 登录身份边界。
- 移动端 MPA 与请求方式。
- 移动端本地联调。
- 开户卡住排查。
- 资质复用缺失排查。
- 结果事件排障。
- B 号关系与额度预占查询。

选择标准是能够覆盖 semantic/procedural、项目作用域、source provenance、graph 关系、近主题 hard-negative 和无答案门控。后续可继续按“账号/权限”“认证/资质”“前端架构”“稳定性/oncall”等主题批次整理。

## 评测数量与方法

### 私有真实评测

本地 ignored suite 共 13 个 case：

- 9 个正向业务问题。
- 项目隔离。
- 无答案与无关问题。
- 1200 token Hook 注入预算。

最终 lexical：

- Recall@1/3/5：1.0。
- MRR：1.0。
- nDCG：1.0。
- false injection：0。
- abstention precision：1.0。
- 平均 context packet：约 570 token。

### 可提交回归评测

- `retrieval-complete.yaml`：18 个 document、20 个 case。
- `project-business-retrieval.yaml`：10 个脱敏 document、12 个 case。

项目业务 fixture 专门复刻本轮发现的 BM25、短 alias、项目隔离、近主题 hard-negative 和无答案问题。

评测数量不是业务知识覆盖率。13 个私有 case 证明首批 9 条知识的检索链路稳定，但不能证明 656 篇文档的所有主题都已抽取或覆盖。若继续扩展知识，应同步为每个主题新增真实用户问题、近主题反例和无答案 case。

## 是否使用 Subagent

本轮没有启动任何 Subagent。

原因：

- 用户没有要求并行代理或委派。
- 当前工具规则只允许在用户明确要求 Subagent/代理并行时使用 `spawn_agent`。
- 文档抓取、候选构建、索引和评测都由主会话直接执行。

避免上下文污染的手段不是 Subagent 隔离，而是：

- 完整正文写 ignored source，不注入检索。
- 只把 33 条精炼知识放入 FTS/embedding。
- Eval 使用独立 YAML case 和结构化 expected/forbidden。
- Eval 默认不写真实 query 日志。
- Context packet 按 token、绝对分数和相对分数门控。
- 私有 eval 与可提交脱敏 fixture 分开。

因此评测并非“另一个不知上下文的 Agent 主观打分”，而是确定性地运行真实 query pipeline，比使用 Subagent 自行判断更可复现。

## 本轮发现并修复的问题

1. 普通 query 未自动携带 Git project ID，项目知识被过滤。
2. BM25 未显式排序，且按固定绝对值缩放，具体 SOP 被压到第 16-18 名。
3. metadata 0 分候选参与 RRF。
4. dense-only/related-only 候选获得虚假 lexical 分。
5. `uid`、`商家中心` 等短 alias 在长查询中获得满分。
6. context packet 只按 token 截断，低相关长尾被注入。
7. Eval 按候选而非最终 packet 判断 forbidden injection。
8. Eval synthetic query 污染真实运行日志。
9. Embedding status 与 provider 使用不同 cacheDir。
10. Source 可能包含测试账号、验证码、密码、token 和个人标识。
11. Source 更新没有安全的同 ID 刷新能力。
12. 图谱把 1458 个节点一次性放进 SVG 圆环，完全不可读。

## Project ID 如何生成

Project ID 与 Git 有直接关系。

流程：

1. `git rev-parse --show-toplevel` 发现 Git root。
2. 读取 `remote.origin.url`。
3. 规范化 remote：
   - 去掉协议、用户名、`.git` 和末尾 `/`。
   - SSH 与 HTTPS 统一成 `host/path`。
   - 转小写。
4. 对规范化 remote 做 SHA-256。
5. 取前 16 个十六进制字符并加 `project_` 前缀。

当前项目：

```text
remote.origin.url:
  github.com/lejunyang/agent-knowledge

sha256:
  222a913d21c0ba913c58b672bd65215b38c5a53d8b9d7e3d43f18b560eafeac6

project id:
  project_222a913d21c0ba91
```

有 remote 时，不使用本机路径，保证同一仓库在不同电脑上得到相同 ID。没有 remote 时才回退到 canonical Git root 路径，因此该 fallback 会与本机路径有关。

Project registry 还记录 Git root、规范化 remote 和当前目录链上的 `AGENTS.md` 路径/hash，但不复制 `AGENTS.md` 正文。

## 后续建议

1. 为递归抓取增加主题 allowlist、最大引用深度和“只保留同空间/同根域”选项。
2. 按主题批次继续整理 656 source，而不是一次性自动激活。
3. 每批新增知识前先建立真实问题和 hard-negative。
4. 对文档更新时间、版本和冲突进行显式审阅。
5. 定期使用 knowledge-organizer 处理 source，但由用户决定是否继续扩展主题。
