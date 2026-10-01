# 接入 arcbench runner 集成指南

本文面向平台方同事：把本 demo 的评测环节替换为现有 arcbench runner（`run_submission.py`），
让自测通道与正式评测共用同一执行逻辑、同一测试镜像、同一测试包。

目标：自测 = 跳过 agent，直接进 runner；除此之外两通道行为完全一致。

---

## 1. 总体结构

demo 的流水线（`server/app/jobs.py` → `runner.py`）：

```
上传 zip → 校验 → 配额扣减 → 构建/启动 app → 就绪探测 → 跑测试包 → 解析结果 → 出分页
```

其中「构建/启动 app → 出分」整段是 `Evaluator` 协议（`server/app/runner.py`）：

```python
class Evaluator(Protocol):
    def evaluate(self, job_id: str, app_src: Path, results_dir: Path) -> EvalResult: ...
```

- 输入：`app_src`（解压后的选手 app 源码目录，根目录含 Dockerfile）、`results_dir`（产物输出目录）、
  以及 `Config` 里的超时/资源/隔离参数。
- 输出：`EvalResult`（状态、通过数、逐条用例、app/runner 日志、测试包哈希、耗时），
  `results_dir` 下放置报告与截图等产物。

**唯一的接入点**：`server/app/main.py` 的 `get_evaluator()`。默认返回
`LocalDockerEvaluator`；设 `SELFTEST_EVALUATOR=arcbench` 后改返回
`server/app/runner_arcbench.py` 的 `ArcbenchRunnerEvaluator`（适配层骨架，已随仓库提供）。
除此之外的 HTTP API、配额、存储、结果页无需改动。

## 2. 模块 / 函数对照表

demo 参考实现（`LocalDockerEvaluator.evaluate`）的每个步骤 ↔ `run_submission.py` 对应函数：

| 步骤 | demo 侧（runner.py / docker_ops.py） | arcbench runner 侧（run_submission.py） |
|---|---|---|
| 构建并启动 app | `DockerOps.build_image` + `run_app`（隔离构建、注入 `PORT`、内网容器） | `run_web_template(stdout_file, stderr_file)`，返回 `{"app_process", "base_url", ...}` |
| app 地址 | `base_url = http://app:{SELFTEST_APP_PORT}` | 模块常量 `WEB_APP_BASE_URL` / `WEB_APP_PORT` |
| 就绪探测 | `runner/wait-ready.mjs`（`READY_TIMEOUT`） | 由 `run_web_template` 内部等待 app 可达后返回 |
| 写测试配置 | `runner/playwright.config.js`（baseURL、超时、并发、截图策略固定） | `write_playwright_config(base_url)` |
| 测试包准备 | 只读挂载 `SELFTEST_TEST_PACK_DIR` 到 `/pack` | `ensure_test_package(stdout_file, stderr_file)` |
| 执行测试 | `DockerOps.run_runner`（Playwright 容器，挂 `/pack`、`/results`） | `run_playwright_tests_with_progress(stdout_file, stderr_file)` |
| 结果解析 | `parse_playwright_report(report.json)` | `parse_playwright_results()` → dict（见 §3） |
| 进度/调试日志 | `EvalResult.runner_log` / `app_log` | `append_runner_event(...)` / `append_debug_log(...)` |
| 子进程管理 | `DockerOps`（容器即进程，按 label 回收） | `start_background_process(...)` |
| 输入规格 | 无（demo 用单一示例包） | `SPEC_PATH`（题目 spec JSON） |

适配层 `ArcbenchRunnerEvaluator._drive()` 已按上表顺序串好调用；需要平台方确认的
只有 `run_submission.py` 模块级常量（`PROJECT_DIR`、`SPEC_PATH` 等）的指向方式，
代码中以 `TODO(platform)` 标出。

## 3. 结果接口对照

`parse_playwright_results()` 返回 dict → `EvalResult`（映射逻辑在
`eval_result_from_runner()`，有单测 `tests/test_runner_arcbench.py`）：

| run_submission.py | EvalResult | 说明 |
|---|---|---|
| `passed` / `failed` | `passed` / `failed` / `total` / `pass_rate` | pass_rate = passed/total × 100，保留 1 位 |
| `tests[]`（逐条：标题、是否通过、错误信息、截图路径） | `tests: list[TestCaseResult]` | 截图路径须为 `results_dir` 相对路径，前端按此取图 |
| `score` | （不入结果页，仅参考） | 自测不出榜，只展示通过率与逐条结果 |
| `duration_seconds` | `duration_s` | |
| `evaluation_status == "skipped"` | `status="error"` + detail | 自测通道要求必须有评测结果 |
| —（无对应） | `pack_hash` | 由 demo 侧 `pack_hash(pack_dir)` 计算，双方核对用同一测试包 |
| app / runner 日志文件 | `app_log` / `runner_log` | 写在 `results_dir` 下 `app.log` / `runner.log`，适配层自动收集（各截尾 8KB） |

状态语义：`done` = 全部通过；`failed` = 有用例失败；`error` = 构建/启动/执行本身失败
（如 60 秒未就绪、构建超时）。三种状态对选手都可见，但 error 不展示为「测试失败」。

## 4. 配置项对照

demo 全部为环境变量（`server/app/config.py`）。接入时保持与正式 runner 一致：

| 环境变量 | 默认 | 对应 runner 侧 | 说明 |
|---|---|---|---|
| `SELFTEST_EVALUATOR` | `local` | — | `arcbench` 启用适配层 |
| `SELFTEST_ARCBENCH_RUNNER_PATH` | `/opt/arcbench/run_submission.py` | runner 本体路径 | 适配层按模块加载 |
| `SELFTEST_APP_PORT` | `3000` | `WEB_APP_PORT` | 注入选手容器的 `PORT` |
| `SELFTEST_TEST_PACK_DIR` / `SELFTEST_HOST_PACK_DIR` | `examples/tests` | `ensure_test_package` 的输入 | 容器内路径 / Docker daemon 视角的宿主路径 |
| `SELFTEST_BUILD_TIMEOUT_S` | 600 | 构建超时 | 与正式一致 |
| `SELFTEST_READY_TIMEOUT_S` | 60 | 就绪探测 | `GET /` 返回 200 为就绪 |
| `SELFTEST_RUN_TIMEOUT_S` | 900 | 测试执行超时 | 与正式一致 |
| `SELFTEST_BUILD_NETWORK` | `none` | 构建期网络隔离 | 与正式一致 |
| `SELFTEST_APP_MEM` / `APP_CPUS` / `APP_PIDS` / `APP_READ_ONLY` | 512m / 1.0 / 256 / 开 | 运行期资源限额 | 与正式一致 |
| `SELFTEST_RUN_NETWORK_INTERNAL` | 开 | 内网（无外网） | 与正式一致 |
| `SELFTEST_DAILY_LIMIT` | 10 | — | 每队每天提交上限（见 §6） |
| `SELFTEST_JOB_WORKERS` | 1 | 并发度 | 单机构建串行；多 worker 时确认 runner 侧端口/目录不冲突 |

原则：**超时、并发、资源限额、网络隔离与正式通道逐项对齐**；有差异即视为两个通道，
结果不可对照。

## 5. 测试包按阶段挂载

- 目录约定：`packs/stage-1/`、`packs/stage-2/`… 每阶段一个目录，结构即 Playwright
  测试包（spec 文件 + 公共 fixture），与正式评测用的是**同一份、同一锁定版本**。
- 挂载：以只读方式挂进 runner（demo：`/pack` 只读卷；`run_submission.py` 侧由
  `ensure_test_package` 接收包路径）。自测服务按所选阶段把对应目录作为
  `SELFTEST_TEST_PACK_DIR` 传入，或在 submit API 上加 `stage` 参数由服务端解析目录。
- 默认阶段：第一阶段；新阶段开放后两通道**同步切换**，包上架时间以平台发布为准。
- 可核对性：每次自测结果带 `pack_hash`（对包内全部文件路径+内容做 SHA-256，
  `server/app/packhash.py`），结果页展示。选手与平台可用哈希确认跑的是同一包；
  正式侧建议同样记录并展示。
- 测试只注入 `BASE_URL`、纯 UI 访问；测试镜像（Playwright 版本、浏览器版本）与正式
  锁定为同一 tag，自测不单独构建测试镜像。

## 6. 配额与身份对接平台账号

demo 是占位实现，接入时替换两处，其余不动：

1. **身份**：`server/app/auth.py` 的 `team_for_token(cfg, token)` 当前是
   `X-Team-Token` 静态映射。替换为平台登录态/SSO：从 session 解析出账号 → 所属队伍，
   返回队伍 ID。可见性规则 `assert_can_view`（结果仅提交队伍可见）保持不变。
2. **配额**：`server/app/quota.py` 的 `Quota` 是本地 SQLite 的「每队每天 N 次」
   （默认 10，`SELFTEST_DAILY_LIMIT`）。接入时：
   - 维度按平台口径：建议每队每题每天 10 次（当前实现未分题，分题只需把
     usage 表主键加一列 stage/problem）；
   - 存储换平台数据库或保留服务内 SQLite 均可，但计数必须在**校验通过后、入队前**
     扣减（`JobService.submit` 已是这个顺序），并发下用 `try_consume` 的原子语义；
   - `GET /api/quota` 返回 `{team, limit, used, remaining}`，前端直接展示。

## 7. 上线检查清单

- [ ] `SELFTEST_EVALUATOR=arcbench` 且 runner 路径可达；示例 app 跑通 done/failed/error 三种结局
- [ ] 逐条对照 §4 表：超时、资源、网络隔离与正式通道一致
- [ ] 测试包为正式同版本，`pack_hash` 与正式侧记录一致并在结果页展示
- [ ] 各阶段包目录就位，默认阶段正确，新阶段两通道同步切换
- [ ] 身份接 SSO 后：A 队看不到 B 队结果（含日志、截图、artifact 接口）
- [ ] 配额：到限返回 429；跨天重置；并发提交不超发
- [ ] 结果页仅本人可见；不入榜、不计正式成绩
- [ ] 失败时给选手的排障材料齐全：逐条错误、失败截图、app 日志、runner 日志
- [ ] 崩溃恢复：服务重启后残留容器/网络按 label 清理（`janitor`），无泄漏
- [ ] 压测：连续提交 N 次（N = 日限额）无句柄/磁盘泄漏，`results_dir` 有容量上限或定期清理

## 8. 不需要改动的部分

HTTP API 形状、CLI（`cli/selftest.py`）、结果存储（`store.py`）、zip 校验
（`validate.py`）、上传限制（50MB / 2000 文件）与前端结果页，均与评测实现解耦，
接入 arcbench runner 时保持原样。
