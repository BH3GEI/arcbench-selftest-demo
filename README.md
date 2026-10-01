# arcbench-selftest-demo

选手上传已生成的 app（zip，根目录含 Dockerfile），拿到测试结果。结果只给提交者看，不进排行榜。

## 主方案：GitHub Actions 评测通道（serverless）

不需要自己部署和运维服务器。题目（`requirements/` + `tests/*.spec.ts`，与 arcbench
题目同格式）放在一个独立的**私有仓库**，由 GitHub Actions 跑评测：

```
选手上传 zip → 触发私有仓库的 workflow（repository_dispatch / workflow_dispatch）
  → docker build（隔离）→ 全新容器（无外网，注入 PORT）→ Playwright 容器
    （只通过 BASE_URL 访问 app，另一个容器）→ 解析结果、按题目可见性过滤
  → 结果回传提交者（回调 API 或私有 Release，不经 Actions 日志）
```

每队每天提交次数上限沿用既有配额逻辑（见下方「本地服务器版」的 `quota.py`）。

详细接入步骤、所需 secrets、怎么把现成的 arcbench 题目文件夹导入、保密边界和
已知局限，见 [`actions/README_ACTIONS.md`](actions/README_ACTIONS.md)。

### 已验证的真实运行结果

用 `demo-todo` 题目（即下方 `examples/app-todo` 改编）在真实私有仓库
`BH3GEI/arcbench-grader-demo` 跑通三种情况：

| 场景 | app | visibility | 结果 | Run |
|---|---|---|---|---|
| 正常提交 | `app-todo`（好） | public | 4/4 通过 | [run](https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36860025835) |
| 测试失败 | `app-todo-broken`（坏） | public | 1/4 通过，3 条失败各带报错文字 | [run](https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36860750858) |
| 隐藏题 | `app-todo`（好） | hidden | 只返回 `passed/total`（4/4），不含逐条信息 | [run](https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36860070293) |

结果均以私有 Release 的形式回传（`result-<submission_id>`），从未出现在 Actions
公开日志里。

## 备选方案：本地 docker compose 服务器版

需要自己部署运行一个常驻服务。接入现有 arcbench runner 的步骤见
[`INTEGRATION.md`](INTEGRATION.md)。

### 流程
上传 → 校验 → docker build（有超时）→ 全新容器（注入 PORT / BASE_URL，就绪探测）→ Playwright 跑测试包 → 返回通过率、逐条结果、失败截图和报错、app 日志、测试包哈希。

每队每天提交次数有上限（默认 10，可配置）。

### 目录
- `server/` HTTP API 和极简网页
- `cli/selftest.py` 命令行上传和查看结果
- `runner/` 跑 Playwright 的容器（测试执行部分可替换为现有 arcbench runner）
- `examples/` 示例 app（正常版和故意坏的版本）和示例测试，`actions/` 的 demo 题目也复用这份
- `scripts/e2e-demo.sh` 端到端演示
- `tests/` 单元测试
- `actions/` GitHub Actions 评测通道模板，见上方「主方案」

### 运行
```
docker compose up
```
