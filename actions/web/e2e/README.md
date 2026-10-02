# 整站回归检查（Playwright）

对线上自测站 `https://arcbench-selftest-web.vercel.app` 做一遍快速回归，确认改完代码没有改坏东西。

- **不提交真实 zip**，不消耗任何人的每日配额，不触发真实评测。
- **不走真实 GitHub OAuth**：需要登录态的页面通过 `page.route()` 拦截 `/api/auth/session`、`/api/tasks`、
  `/api/submissions`、`/api/submissions/[id]`、`/api/submissions/[id]/screenshot` 几个接口，用
  `fixtures/mockApi.ts` 里构造的模拟数据（覆盖全部通过/部分失败/系统错误/排队中/隐藏题等状态）直接驱动
  页面渲染，页面本身仍然是从线上 Vercel 部署加载的真实代码。
- 需要真正验证"未登录"保护（`RequireAuth`）的用例，不 mock，直接用全新、无 cookie 的浏览器上下文访问，
  天然等价于未登录。

## 跑法

```bash
cd actions/web
npm install            # 只用官方 registry.npmjs.org

# 首次需要下载浏览器。浏览器装到项目内 .playwright-browsers/，不要装到默认的
# ~/Library/Caches/ms-playwright —— 共享机器磁盘紧张时，系统会把 ~/Library/Caches
# 当成可随时清空的缓存，装一半/刚装完就可能被清掉，报 "Executable doesn't exist"。
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers"
npx playwright install chromium

npm run e2e
```

之后每次跑测试前，记得重新 `export PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers"`（或写进当前 shell
的 profile），否则 `playwright test` 会去默认位置找浏览器。

跑完看报告：`npm run e2e:report`（打开 `e2e/report/index.html`）。

默认对线上地址跑；如果要对别的环境跑（比如本地 `next dev`），设置 `E2E_BASE_URL`：

```bash
E2E_BASE_URL=http://localhost:3000 npm run e2e
```

## 覆盖范围

对应 `ux-prep/UX-TREE.md` 里"不需要真实提交"的全部页面和状态，以及 `findings-A/B/D.md` 里每一条已经
标注要修的问题，各写一条回归断言：

| 文件 | 覆盖 |
|---|---|
| `home.spec.ts` | 首页未登录落地页、已登录问候语、最近提交限 3 条、排队态"—"、配额显示、状态徽章 |
| `not-found-and-errors.spec.ts` | 404 自定义页（findings-A #5）、`/auth/signin` 取消授权/回调失败的中文样式页（findings-A #1/#2） |
| `require-auth.spec.ts` | 未登录直接访问需登录页面，统一落到"需要登录"占位 |
| `theme.spec.ts` | 主题按钮 aria-label 与可见文字语义一致（findings-D #1）、刷新保持、首次访问跟随系统偏好（findings-D #5） |
| `tasks.spec.ts` | 题目列表渲染、空状态 |
| `submit.spec.ts` | dropzone 文件校验（非 zip/空文件/超大）、配额用尽禁用提交、文件输入 aria-label（findings-B #5，预期仍失败）、zip 要求端口说明（findings-B #4，预期仍失败）、未列出 taskId 深链接（findings-A #4，预期仍失败） |
| `submissions-list.spec.ts` | 历史记录标题/配额文案、各状态徽章不混用（findings-D #3）、"—"一致性 |
| `submission-detail.spec.ts` | 全部通过/部分失败/未能运行/系统错误/隐藏题/排队中各状态；截图链接指向本站接口且图片真的能加载（findings-B #1）；得分摘要无英文残留（findings-B #2） |
| `mobile.spec.ts` | 移动端窄屏仍保留（截断的）用户名，而不是整个隐藏（findings-D #4） |

## 关于"预期仍失败"的用例

`submit.spec.ts` 里标了 3 条用例，是 findings 里**截至本次检查仍未修复**的问题（文件选择控件无
aria-label、zip 说明没写监听依据、未列出的题目 ID 深链接不做前端校验）。这些测试按"期望中的正确行为"
写断言，如果线上还没修，测试会**失败**——这正是本套回归检查要汇报的"线上仍存在的问题"，不是测试本身写错了。
等对应修复上线后，这些用例会自动转绿，不需要再改断言。
