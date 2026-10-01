# arcbench-selftest-demo

选手上传已生成的 app（zip，根目录含 Dockerfile），拿到测试结果。结果只给提交者看，不进排行榜。

本仓库提供两种部署方式，接口形状、隔离方式、配额逻辑一致，差别只在"评测跑在哪里"。
两种都能独立跑完整条链路，按自己的部署偏好选：

## GitHub Actions 评测通道（serverless）

不需要自己部署和运维服务器。题目（`requirements/` + `tests/*.spec.ts`，与 arcbench
题目同格式）放在一个独立的**私有仓库**，由 GitHub Actions 跑评测：

```
选手上传 zip → 触发私有仓库的 workflow（repository_dispatch / workflow_dispatch）
  → docker build（隔离）→ 全新容器（无外网，注入 PORT）→ Playwright 容器
    （只通过 BASE_URL 访问 app，另一个容器）→ 解析结果、按题目可见性过滤
  → 结果回传提交者（回调 API 或私有 Release，不经 Actions 日志）
```

适合：不想自己运维常驻服务、愿意把题目放进一个独立私有仓库、评测量不算特别大
（受 GitHub Actions 并发任务数和每月分钟数限制）的场景。

每队每天提交次数上限沿用既有配额逻辑（见下方「docker compose 服务器版」的 `quota.py`）。

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

## docker compose 服务器版

需要自己部署运行一个常驻服务：一个 HTTP API 进程，通过 Docker socket 拉起
同主机上的兄弟容器完成 build / run / 测试，配额和结果都存在这个服务自己的数据目录里。

```
选手上传 zip → POST /api/submissions（校验、配额扣减）
  → docker build（隔离）→ 全新容器（注入 PORT，就绪探测）
    → Playwright 容器（只通过 BASE_URL 访问 app，另一个容器）
  → 解析结果（通过率、逐条结果、失败截图和报错、app 日志、测试包哈希）
  → 存入本地数据目录，选手按 submission id 轮询取结果
```

适合：已经在自己运维基础设施、想要一个常驻服务自己掌控鉴权 / 配额 / 结果存储、
或不想依赖第三方 CI 产品的场景。接入现有 arcbench runner 的步骤见
[`INTEGRATION.md`](INTEGRATION.md)，部署步骤、配置项、保密边界和已知局限见
[`server/README_SERVER.md`](server/README_SERVER.md)。

每队每天提交次数有上限（默认 10，可配置）。

### 运行
```
docker compose up
```

## 两个版本对照表

| | GitHub Actions 版 | docker compose 服务器版 |
|---|---|---|
| 运维负担 | 不需要自己的常驻服务，依赖 GitHub Actions | 需要自己部署、运维一个常驻服务 |
| 题目存放 | 独立私有仓库的 `tasks/<task_id>/` | 一份测试包目录（`SELFTEST_TEST_PACK_DIR`），单部署单包 |
| 隔离方式 | 隔离构建 + 无外网容器 + 内网 runner 容器 | 相同：隔离构建 + 无外网容器 + 内网 runner 容器 |
| 可见性（hidden/public） | 按题目 `requirements.yaml` 过滤，已实现 | 未实现，按队隔离但同队内全量可见 |
| 结果回传 | 回调 API 或私有 Release，不经 Actions 日志 | HTTP API 轮询，结果存本地数据目录 |
| 配额 | 复用 `server/app/quota.py` 的每队每天上限 | 同一套 `quota.py` 实现 |
| 接入正式 arcbench runner | 未提供适配层 | `SELFTEST_EVALUATOR=arcbench`，见 `INTEGRATION.md` |
| 并发扩展 | 依赖 GitHub Actions 并发任务数配额 | 单机 `SELFTEST_JOB_WORKERS`，受限于宿主机资源 |
| 已验证真实运行结果 | 见上方「已验证的真实运行结果」 | 见 `server/README_SERVER.md`（待补） |

更详细的差异点正在整理为 [`docs/parity.md`](docs/parity.md)，补齐后这里会直接引用它。

## 目录

- `server/` HTTP API 和极简网页（docker compose 服务器版）
- `cli/selftest.py` 命令行上传和查看结果
- `runner/` 跑 Playwright 的容器（测试执行部分可替换为现有 arcbench runner）
- `actions/` GitHub Actions 评测通道模板和模板文档
- `examples/` 示例 app（正常版和故意坏的版本）和示例测试，两个版本的 demo 题目都复用这份
- `scripts/e2e-demo.sh` 端到端演示（docker compose 服务器版）
- `tests/` 单元测试
