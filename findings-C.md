# 任务 C 遍历结果 — 异常上传、配额、权限边界

测试环境：https://arcbench-selftest-web.vercel.app ，账号 BH3GEI，Cindy 浏览器真实操作（外置 Chrome，CDP）。
素材：`/Users/mac/hackathon-octos/ux-prep/fixtures/`。截图：`shots-C/`。

> 说明：测试过程中账号配额跨过了每日 UTC 0:00 重置点（期间从 7/10 变化到 10/10），且与任务 A/B/D 共用同一浏览器 cookie（任务 A 测试退出登录时，全部任务一起被登出，之后重新登录即恢复，不作为网站问题记录）。下面涉及配额消耗的结论，均基于重置后、无并发提交噪音时段的干净对照（上传前后立即对比"今日剩余次数"）。

---

## 问题列表（按严重程度）

### 1. 【严重】超大文件（>50MB）上传后无任何错误提示，静默失败
- **复现**：在 `/submit/github-stage-1-req-test` 选择 `oversized-51mb.zip`（~52MB，超过文档宣称的 50MB 上限）。
- **实际表现**：拖拽区直接恢复为初始空状态（"拖入 zip 文件，或点击选择"），**没有出现任何"超过 50 MB 上限"文案**，提交按钮保持 disabled，用户完全不知道发生了什么、也不知道该怎么办。复现两次结果一致。
- **预期行为**（据 UX-TREE 文档）：应显示"文件 X MB，超过 50 MB 上限。"的红色错误提示。
- **影响**：用户上传大文件会以为程序卡住或自己点击失败，可能反复重试，体验上是一个明显的"失败但看起来什么都没发生"的黑洞。
- **截图**：`shots-C/04-oversized-51mb-no-feedback.png`（对比 `01-upload-page-initial.png` 几乎一样，没有错误提示）。
- **建议**：检查 `checkFile()` 对大文件的分支——很可能是文件大小判断逻辑在超过某个阈值时没有触发 setError，或者 dropzone 组件在处理大 File 对象时提前 return 导致状态没更新。需要让 50MB+ 文件也能正确命中"超过 50MB"提示。

### 2. 【建议】小于 1KB 的文件在"已选择"提示里显示为"0 KB"，容易和"空文件"混淆
- **复现**：选择 `not-a-zip.zip`（40 字节）或 `path-traversal.zip`（324 字节），提示文案为"已选择 xxx.zip · **0 KB**"。
- **影响**：0 KB 的显示和"文件是空的"报错在视觉上太接近，用户可能误判这是空文件。
- **建议**：小文件按字节显示（如 "40 B"）或至少显示"< 1 KB"，不要四舍五入成 0。
- **截图**：`shots-C/03-not-a-zip-selected-0KB.png`

### 2b. 【建议】后端错误 detail 原文是纯英文，与站点中文化风格不一致
- **复现**：`no-dockerfile.zip` 提交后，结果页中文提示"app 未能启动"下方直接贴出原始 detail："no Dockerfile at the root of the submitted app"。
- **说明**：这不是敏感信息泄露（没有服务器路径、堆栈），但纯英文原文和页面其余部分的中文风格脱节，对不熟悉英文的选手不够友好。
- **截图**：`shots-C/06-no-dockerfile-result.png`

---

## 验证通过（符合预期，无问题）

| 测试项 | 结果 |
|---|---|
| `empty.zip`（0 字节） | 客户端即时拦截"文件为空。"，按钮 disabled，**未发起网络请求，不计配额**。截图 `02-empty-zip-rejected.png` |
| `not-a-zip.zip`（.zip 后缀但非法格式） | 前端放行（只看扩展名），提交后命中后端 magic-number 校验，返回 400，中文化为"文件不是有效的 zip 格式。"，**确认不计配额**（配额前后均为 10/10） |
| `no-dockerfile.zip` | 正常走完排队→构建，最终 `error`，页面显示"app 未能启动"+ "镜像构建或启动失败，测试未执行。请检查 Dockerfile 和启动命令。"，**计入配额**（符合预期）。截图 `05-no-dockerfile-waiting.png`、`06-no-dockerfile-result.png` |
| `path-traversal.zip`（zip 条目含 `../../etc/evil.txt`） | 前端放行上传，评测端 `zipsafety.py` 拦截，结果页显示"未能运行" + "zip 包未通过安全检查：zip 中含有不允许的路径（如 ../ 或绝对路径）、解压后体积过大或文件数过多。请在 app 根目录下重新打包后再提交。本次计入当日次数。"——**消息干净、没有泄露任何服务器路径或堆栈信息**，且明确告知计入次数，体验上做得很好。截图 `07-path-traversal-result.png` |
| 隐藏题目 `demo-todo` 直接访问 `/submit/demo-todo` | 已登录状态下前端**确实不拦截**，正常渲染上传表单（标题直接显示原始 ID "demo-todo"，没有展示名），与文档描述一致 |
| 向隐藏题目 `demo-todo` 实际提交文件（`good-app-todo.zip`） | 后端 `isTaskListed` 校验生效，返回"题目不存在。"，**不计配额**，没有任何信息泄露（不会暴露这题到底存不存在之外的信息）。截图 `08-demo-todo-hidden-task-rejected.png` |
| 未登录访问 `/api/submissions`、`/api/submissions/[id]`、`/api/tasks`、POST `/api/submit`（无 cookie curl 直连） | 全部返回 `401 {"error":"sign in required"}`，无数据泄露 |
| 访问不存在的提交 ID（`/api/submissions/00000000-0000-0000-0000-000000000000`） | 返回 `404 {"error":"not found"}`，干净，无额外字段泄露 |
| QuotaCard 在上传页 / 首页 / 历史记录页三处数字 | 观察到的几次都一致（如 10/10），未发现不同步 |

---

## 未能完成的检查项（说明原因）

- **配额用尽后的 429 与按钮完全 disabled 的验证**：由于本账号配额与任务 A/B/D 共享，且任务说明要求"配额用尽放最后测、本任务最多用 6 次"，为避免挤占其他任务的配额，未主动把配额刷到 0。已通过"本次计入当日次数"文案 + 前后配额数字对比，间接确认计数逻辑正确（有效提交记次、客户端/后端前置校验不记次）。
- **访问他人真实提交 ID**：没有第二个测试账号的真实 submission id 可用，只测试了随机 UUID（404，无泄露），未能验证"猜中真实存在但属于别人的 id"这一具体场景；但从代码逻辑和 404 行为看，所有权校验应该是在同一查询里完成的，风险较低。

---

## 本次实际配额消耗

本任务共发起 2 次真实评测提交（`no-dockerfile.zip`、`path-traversal.zip`），均在预算的 6 次以内；`empty.zip`/`not-a-zip.zip`/`oversized-51mb.zip`/`demo-todo` 均确认不消耗配额。
