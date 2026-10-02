# ArcBench 选手自测网站 — UX 树 / 用户旅程 / 遍历拆分

- 线上：https://arcbench-selftest-web.vercel.app
- 代码：https://github.com/BH3GEI/arcbench-selftest-demo，本文基于 `actions/web/`（Next.js App Router + NextAuth + Vercel Blob/KV）
- 本地只读 clone：`/Users/mac/hackathon-octos/ux-prep`（**不改代码**，仅做遍历准备）
- 说明：网站还在改（登录、设计、安全），以下基于当前代码快照；执行遍历时如发现与本文不符，以线上实际行为为准，并在报告里标出差异。

---

## 0. 页面地图（路由总览）

| 路由 | 文件 | 鉴权 | 作用 |
|---|---|---|---|
| `/` | `app/page.tsx` | 公开（内容按登录态分支） | 首页：未登录是落地页+登录按钮；已登录是欢迎+最近提交+剩余次数+怎么用 |
| `/tasks` | `app/tasks/page.tsx` | 需登录（`RequireAuth`） | 题目列表，点一个题目进入上传页 |
| `/submit/[taskId]` | `app/submit/[taskId]/page.tsx` | 需登录 | 上传 zip 表单（拖拽/选择文件） |
| `/submissions` | `app/submissions/page.tsx` | 需登录 | 历史记录列表（状态/得分/时间） |
| `/submissions/[id]` | `app/submissions/[id]/page.tsx` | 需登录 + 必须是自己的提交 | 结果详情页（排队/运行中/通过/部分通过/出错/系统错误 + 测试明细） |
| `/api/tasks` | API | 需登录 | 返回题目列表（过滤 `UNLISTED_TASK_IDS`） |
| `/api/submit` | API (POST) | 需登录 | 上传 zip → 存 Blob → 建提交记录 → dispatch 评测 |
| `/api/submissions` | API | 需登录 | 当前用户全部提交 + 今日配额 |
| `/api/submissions/[id]` | API | 需登录 + 所有权校验 | 单条提交详情（供轮询） |
| `/api/callback` | API (POST) | HMAC 签名校验（不是用户态） | 评测系统回调写入结果，前端不直接访问 |
| `/api/auth/[...nextauth]` | NextAuth | — | GitHub OAuth 登录/登出 |

未匹配路由（如 `/submissions/`、随便打的路径）：当前没有自定义 `not-found.tsx`/`error.tsx`，走 Next.js 默认 404/500 页面——**这是一个可能的 UX 缺口，遍历时请记录**（没有站点统一风格的 404）。

全局结构（`app/layout.tsx` + `app/_ui/index.tsx`）：
- 顶部 `SiteHeader`：品牌（首页链接）+ 主导航（仅登录后显示：`提交自测`/`历史记录`）+ 主题切换按钮（亮/暗，存 `localStorage.theme`，首帧注入脚本避免闪烁）+ 用户徽标（头像+用户名+退出按钮，仅登录后）
- 顶部 `.skip-link`："跳到主要内容"，键盘用户专用的跳转链接
- 底部 `SiteFooter`：固定文案
- 所有需鉴权页面统一用 `RequireAuth` 包裹：`loading` → 骨架屏；无 session → 居中卡片"请先登录"+登录按钮；有 session → 渲染真实内容

---

## 1. 完整 UX 树（页面 × 状态 × 跳转）

### 1.1 全局状态维度（贯穿多页）
- **登录态**：未登录 / 登录中(`status==='loading'`) / 已登录
- **主题**：亮色 / 暗色（手动切换，优先于系统偏好；也有"跟随系统"的初始值）
- **配额**（`QuotaCard`，来自 `/api/submissions` 的 `quota` 字段，有 fallback 用本地计算）：剩余 N/limit，剩余为 0 时数字变红
- **提交状态** `effectiveStatus()`：`queued`(排队中) → `running`(运行中，前端推断，后端暂无此真实状态字段，可能永远跳过) → `passed`(全部通过) / `failed`(部分未通过) / `error`(运行出错) / `system_error`(系统出错·不计次，由 `error` + detail 文本正则推断)
- **可见性** `result.visibility`：`public` 正常显示测试明细 / `hidden` 隐藏题——只显示通过数，不展示每条测试内容和报错

### 1.2 首页 `/`
```
未登录
├─ Hero：标题 + "使用 GitHub 登录"按钮(大) + 隐私说明("只读取 GitHub 公开资料")
├─ Facts 三卡：不计成绩 / 每天 10 次 / 和正式评测同环境
├─ HowTo 三步：打包 → 选题上传 → 看结果
└─ 点"登录" → GitHub OAuth 授权页(外站) → 回调 /api/auth/callback/github → 回到 /（已登录态）

已登录
├─ "你好，{昵称}" + "开始自测"按钮(大, primary) → /tasks
├─ 左列"最近提交"(最多3条)
│   ├─ 加载中：骨架屏
│   ├─ 空：空状态卡片"还没有提交过，先选一道题试试"
│   └─ 有数据：列表行(题目/得分或相对时间/状态徽标) → 点击 → /submissions/[id]
│   └─ "全部记录 →" → /submissions
└─ 右列：QuotaCard(今日剩余次数) + HowTo
```

### 1.3 题目列表 `/tasks`（需登录，否则见 1.0 RequireAuth 占位）
```
├─ 加载中：3 个骨架卡片
├─ /api/tasks 报错：红色 Notice + 中文化错误信息
├─ 空列表："暂时没有可自测的题目"
└─ 有题目：卡片网格，每卡"题目名 + 上传并自测 →" → /submit/[taskId]
```
隐藏/未列出题目（`UNLISTED_TASK_IDS`，如 `demo-todo`、`demo-todo-hidden`）不会出现在这个列表，但 `/submit/<那个id>` 直接访问时**前端不拦**（只在提交时后端 `isTaskListed` 校验失败才报错）——这是一个值得专门走一遍的路径。

### 1.4 上传页 `/submit/[taskId]`（需登录）
```
├─ 面包屑："选择题目 / 上传" + 题目名(displayName)
├─ 拖拽/点击上传区(dropzone)
│   ├─ 空：提示"拖到这里或点击选择文件" + "仅支持.zip，最大50MB"
│   ├─ 拖拽悬停：高亮态(is-over)
│   ├─ 选中文件：文件名+大小 pill + "点击或拖入可更换" + "移除文件"按钮
│   └─ 客户端校验 checkFile()：
│       ├─ 非 .zip 扩展名 → "只能上传 .zip 文件。"
│       ├─ 超过 50MB → "文件 X MB，超过 50 MB 上限。"
│       └─ 0 字节 → "文件是空的。"
├─ 今日次数用完(outOfQuota)：黄色 Notice "今天的次数已用完" + 提交按钮 disabled
├─ 点"开始自测"：
│   ├─ busy 态：按钮变 spinner "正在上传…"，input disabled
│   ├─ 成功 → router.push(`/submissions/{id}`)
│   └─ 失败(各类后端400/401/403/429/502) → 红色 Notice，中文化错误(zhError)：
│       ├─ 401 未登录/会话过期 → "登录已失效，请重新登录。"
│       ├─ 400 taskId/file 缺失、非zip、超大、未知题目
│       ├─ 403 "GitHub account must be at least N days old" → "GitHub账号注册时间太短，暂时不能使用自测。"
│       ├─ 429 "daily submission limit reached" → 用户配额用尽
│       ├─ 429 "overall daily submission limit" → "今天全站的自测名额已满"
│       └─ 502 "upload failed"/"could not start grading" → "评测系统出错，本次不计次数，请稍后重试。"
└─ 右侧卡片：QuotaCard + "zip格式要求"说明(根目录放Dockerfile、监听端口、不要打包node_modules/.git、不超50MB) + 目录树示例
```

### 1.5 历史记录 `/submissions`（需登录）
```
├─ 顶部："今天还剩 X/N 次自测" + "新的自测"按钮 → /tasks
├─ 加载中：骨架屏
├─ 报错：红色 Notice
├─ 空："还没有提交记录" + "去提交"按钮 → /tasks
└─ 有记录：表格(题目/状态徽标/得分进度条/提交时间/箭头) 每行可点 → /submissions/[id]
    状态徽标颜色：排队中(灰,live) / 运行中(蓝,live) / 全部通过(绿) / 部分未通过(红) / 运行出错(黄) / 系统出错·不计次(黄)
```

### 1.6 结果详情 `/submissions/[id]`（需登录 + 所有权）
```
├─ 404/所有权校验失败(访问别人的结果链接，或 id 不存在) → API返回{error:'not found'},404 → 前端显示"找不到这条提交记录。"+"← 返回历史记录"
├─ status==='queued' 或 'running'：Waiting 组件
│   ├─ 排队中：有 queuePosition 则"前面还有N个提交"，否则"等待评测机空闲"
│   ├─ 运行中："正在构建你的app并运行测试"
│   ├─ 已等待计时(每秒刷新) + 预计还需时长(或"比平时稍久，请再等一下")
│   ├─ 5 步时间线(已上传/排队/构建镜像/运行测试/出结果)，当前步高亮
│   ├─ 每4秒轮询 /api/submissions/[id]
│   └─ "页面会自动刷新，你可以先离开，稍后在「历史记录」里查看结果。"
├─ status==='system_error'：黄色 Notice"评测系统出错，本次不计次数" + detail原文(mono) + "重新提交"按钮
├─ status==='error' && total===0：红色 Notice"app没能跑起来"(构建/启动失败) + detail(pre,通常是构建日志片段)
├─ 有 result 且非pending非system_error且total>0：
│   ├─ Score 卡片：通过数/总数 + 百分比 + 进度条(绿=全通过/红=全挂/默认=部分)
│   ├─ hidden(visibility==='hidden' 或无tests字段)：eye-off图标 + "这道题是隐藏测试题，只显示通过数量…"
│   └─ 非hidden且有tests：Tests 组件
│       ├─ 筛选tab：全部N / 未通过N / 通过N (默认：有失败则先显示"未通过")
│       ├─ 每条测试：✓/✗图标 + 标题 + 耗时
│       ├─ 失败且有error或截图 → 可展开(details/summary)：报错文本(pre) + 截图(img, 新窗口打开原图)
│       └─ 筛选后空列表："没有未通过的测试 🎉" 或 "这里没有测试"
└─ 顶部始终有"再交一次" → /submit/[taskId]
```

### 1.7 跨页统一元素
- **RequireAuth 占位**：任何需登录页面，未登录直接访问 → 居中卡片"请先登录" + 登录按钮（不是重定向到首页，URL 保留原路径）
- **主题切换**：任意页面右上角按钮，暗色/亮色图标切换，`localStorage` 持久化，刷新后保持
- **会话过期**：session cookie 失效后，页面内 fetch 多数会拿到 401 `sign in required`，由各页面自行展示错误或 `RequireAuth` 接管（取决于 NextAuth 客户端 session 是否也已失效）

---

## 2. 用户角色与旅程

1. **新选手首次使用**：落地页 → 看 Facts/HowTo → GitHub 登录(含 OAuth 授权页跳转) → 回首页(已登录态，最近提交为空) → "开始自测" → 选题目 → 看 zip 格式要求 → 打包好的 zip 拖进上传框 → 提交 → 等待(排队/运行中动画) → 看结果
2. **交好的 app**：全程顺畅，最终 passed，Score 显示 100%，测试明细全绿，筛选默认"全部"
3. **交坏的 app**（构建失败/启动失败/测试全挂）：
   - 没 Dockerfile 或构建失败 → `error`+total=0 分支，"app没能跑起来"+构建日志
   - 能跑但测试全挂 → `failed`，Score 红色，筛选默认"未通过"，每条展开看报错和截图
4. **交一半的 app**（部分测试通过）：`failed`，Score 显示部分通过(非全红非全绿)，筛选默认"未通过"能看到挂的，切到"通过"能看到过的
5. **次数用尽**：到第11次（或配置的N+1次），上传页"今天的次数已用完"Notice，提交按钮disabled；首页/历史记录的 QuotaCard 显示 0（红色数字）；若恰好此时又提交(如并发多标签页)会拿到429，被中文化为对应提示
6. **手机用户**：窄屏下 header 导航、`.split` 两栏(上传表单+侧栏)、`.grid` 题目卡片、表格各行是否能合理换行/横向滚动；拖拽上传区在触屏上退化为"点击选择文件"；长文件名/长题目名用了 `overflowWrap:anywhere`，需验证真机效果
7. **暗色模式用户**：切换主题后检查所有 Notice(info/warning/danger三色)、StatusBadge(6种状态色)、进度条、骨架屏、截图展示区在暗色下的对比度和可读性；刷新页面主题是否保持(无闪烁)
8. **只用键盘的用户**：Tab 顺序(skip-link → header nav → 主题按钮 → 退出 → 页面内容)；dropzone 能否用键盘触发文件选择(label+input的可达性)；details/summary 展开测试详情、tabs(筛选按钮 aria-pressed)、进度条(role=progressbar)的焦点可见性和 Enter/Space 操作；截图链接(`<a target=_blank>`)的可达文案
9. **碰到系统故障/长时间排队**：
   - 排队位置一直很大或不下降、运行中超过预计时长很多（"比平时稍久，请再等一下"分支）
   - system_error：评测系统自己挂了，不计次数，detail 原始错误文本直接暴露给用户(可能不够"人话"，需评估是否要进一步中文化)
   - /api/callback 本身对用户不可见，但其异常会反映为提交长期停在 queued 不更新——需要验证前端是否有"等太久了"的兜底提示(目前只有基于 TYPICAL_SECONDS 的文案，没有真正的超时上限/失败兜底)
10. **访问别人结果链接**：拿到/猜到别人的 submission id（如从历史记录里 URL 规律推测，或别人分享了链接）→ `/submissions/{别人的id}` → API 404 → "找不到这条提交记录。"（不会泄露存在与否之外的信息，但要确认不会显示别人的任何数据片段，哪怕一瞬间）
11. **GitHub 账号太新**：账号注册不满 `SELFTEST_WEB_MIN_ACCOUNT_AGE_DAYS`(默认7天)——能正常登录、浏览题目、进上传页，**只在真正点击提交时**才会 403 拒绝，文案"GitHub账号注册时间太短，暂时不能使用自测。"——需要验证这个"先让你走到最后一步才拒绝"的体验是否应该提前到登录后就提示

---

## 3. 测试素材（`fixtures/` 目录，已生成）

来源：仓库 `examples/` 下的三个示例 app + `contestant/template/`；**不包含比赛题目内容**（仓库里也没有看到真实赛题代码，`tasks/` 目录不在这个前端 repo 里）。

| 文件 | 内容 | 预期用于验证 |
|---|---|---|
| `good-app-todo.zip` | `examples/app-todo/`（含 Dockerfile+server.js），根目录直接有 Dockerfile | 正常全通过路径（实际是否 passed 取决于后端题目测试，仅结构合规） |
| `bad-app-todo-broken.zip` | `examples/app-todo-broken/` | 构建/运行失败或测试全挂路径 |
| `partial-app-todo-partial.zip` | `examples/app-todo-partial/` | 部分通过路径 |
| `no-dockerfile.zip` | 同 good，但删掉了 Dockerfile | 触发"zip 必须在根目录包含 Dockerfile"(`failed`，"no Dockerfile at the root") |
| `path-traversal.zip` | 手工构造，一个条目路径为 `../../etc/evil.txt` | 触发 `zipsafety.py` 的 "unsafe path in zip" 校验（在评测端被拒，前端 `/api/submit` 本身不检查路径，只检查 magic number + 大小，所以这个 zip 能上传成功，但评测会标记为参与者失败） |
| `oversized-51mb.zip` | 随机不可压缩数据，zip 文件本体 ~52MB | 触发前端 `checkFile()` 的 "超过 50 MB 上限" 提示，以及（绕过前端直接调 API 时）后端 `zip exceeds 50MB` 400 |
| `not-a-zip.zip` | 纯文本文件，改了 `.zip` 后缀，magic number 不对 | 前端扩展名校验会放过（看文件名），上传后后端 magic-number 检查返回 "not a zip file" 400（中文化："这不是有效的.zip文件"）——适合专门测"前端校验漏了、靠后端挡住"的场景 |
| `empty.zip` | 0 字节文件 | 触发前端"文件是空的。" |

补充：没有做"zip 炸弹"(总解压超50MB但压缩后很小)样本，若后续要测 `zipsafety.py` 的 `max_total_bytes` 限制，可以用大量重复数据+高压缩比构造，当前 fixtures 未覆盖，留给后续任务。

---

## 4. 并行遍历任务拆分（4 份，互不重叠）

> 每份建议配 1 个浏览器自动化 agent，登录同一个或各自的测试 GitHub 账号（账号年龄需 ≥7 天，否则任务A4会先天受阻——建议至少准备1个"老账号"用于A/B/C，1个可选的"新账号"专门给D4）。请先截图/记录初始状态（今日已用次数），避免相互抢配额；若共用一个账号，4 份合计上传次数请控制在当日配额(默认10)以内，必要时提前沟通谁用哪几次。

### 任务 A — 首次访客 + 登录 + 导航骨架
路径：`/`(未登录) → 登录流程(GitHub OAuth) → `/`(已登录) → header导航往返(`/tasks`↔`/submissions`↔`/`) → 退出登录 → 退出后再访问需登录页面(验证RequireAuth占位)
检查点：
- 未登录首页三个Facts卡片、HowTo三步文案是否清晰、隐私说明是否可见
- 登录按钮点击后 OAuth 授权页信息是否符合预期(请求的权限范围)、取消授权返回站内是否优雅
- 已登录首页问候语、"开始自测"按钮、最近提交为空态文案
- header 在已登录/未登录两种态下导航项差异是否符合预期
- 主题切换按钮在**这组路径**里的表现(切换、刷新保持)
- 退出登录后 session 失效，直接改URL访问 `/tasks`、`/submissions`、`/submit/<任意id>`、`/submissions/<任意id>` 是否都正确落到"请先登录"占位
- 未匹配路由(如 `/foo-bar-not-exist`)当前的404表现（记录现状，不一定是bug）

### 任务 B — 正常提交全流程（好/坏/部分 三种 app）
路径：`/tasks` → 逐一选题 → `/submit/[taskId]` 上传 `fixtures/good-app-todo.zip`、`bad-app-todo-broken.zip`、`partial-app-todo-partial.zip` 三个文件（对应三次独立提交，可用同一个题目重复提交，也可以用不同题目各提交一次，取决于当前题库有几个题目）→ 等待出结果 → `/submissions/[id]` 查看详情 → 回 `/submissions` 列表核对
检查点：
- 上传前"zip格式要求"卡片内容是否准确、目录树示例是否帮助理解
- dropzone 拖拽态/选中态/移除文件交互
- 提交后按钮loading态、跳转到结果页的时机
- 排队中/运行中 Waiting 组件：计时是否准确递增、时间线5步高亮是否随状态推进、是否会一直卡在某一步
- 三种结果各自的 Score 展示(全绿/全红/部分)、测试明细默认筛选tab是否符合"有失败先显示未通过"的预期
- 展开单条测试的报错文本和截图(如果有)是否正常加载、截图点击新开页是否显示原图
- 历史记录列表里这三条记录的状态徽标颜色、得分进度条、时间显示是否和详情页一致
- 首页"最近提交"是否同步出现这三条

### 任务 C — 异常上传与配额/权限边界
路径：`/submit/[taskId]` 分别尝试上传 `fixtures/` 里的 `no-dockerfile.zip`、`not-a-zip.zip`、`empty.zip`、`oversized-51mb.zip`、`path-traversal.zip`；然后做配额边界(连续提交到用尽或接近用尽，视当日剩余额度决定做几次，**优先用低成本的 empty.zip/not-a-zip.zip 这类会被直接拒绝、不消耗配额的来试探是否真的不计次**)；最后用浏览器直接改 URL 访问一个确定不属于自己的 `/submissions/<id>`（如构造一个随机UUID，或如果能拿到另一测试账号的某条记录id）
检查点：
- 每种坏文件的前端即时校验文案(客户端checkFile) vs 提交后端返回的错误文案(zhError中文化)是否都出现、是否一致、是否有裸露的英文原文或stack trace泄漏
- `oversized-51mb.zip`：确认前端选中文件后立刻拦截(不发请求)，文案里的MB数字是否准确
- `path-traversal.zip`：这个文件前端会放行上传（只查magic number），需要跟到提交之后的最终状态(最可能是 failed，detail里是否出现了不该暴露的服务器路径或堆栈信息)
- `no-dockerfile.zip`：确认最终状态文案"app没能跑起来"+detail提到Dockerfile
- 配额用尽后上传页按钮disabled态、Notice文案；QuotaCard在首页/历史记录/上传页三处是否同步显示为0且变红
- 故意再调一次(如果UI没完全disabled，或用浏览器devtools直接触发表单提交)验证是否真的拿到429而不是误放行
- 访问他人/不存在的 submission id：确认统一是"找不到这条提交记录"而不是500或信息泄漏，检查网络面板里 /api/submissions/[id] 的响应体有没有多返回字段

### 任务 D — 可访问性、响应式与弱网/长等待体感
路径：覆盖 A/B/C 已经走过的核心页面(`/`、`/tasks`、`/submit/[taskId]`、`/submissions`、`/submissions/[id]`)，但换维度重新过一遍，不新造业务路径
检查点：
1. **键盘只用**：从地址栏Tab进入，验证skip-link可见可用 → header每个可交互元素顺序合理 → 上传页能否不用鼠标完成"选择文件"(拖拽区的label/input关联) → 结果页测试明细的筛选按钮(role=group,aria-pressed)和每条测试的`<details>`展开能否用Enter/Space操作、焦点态是否可见
2. **暗色模式**：切到暗色，重新截图上述5个页面的所有可见状态(含Notice三色、StatusBadge六色、进度条、骨架屏)，核对文字对比度、图标可见性；刷新页面确认无闪烁、主题保持
3. **响应式/手机**：用浏览器设备模拟(如 iPhone 尺寸)重新过上述5个页面，重点看：header在窄屏是否挤/换行、`/tasks`题目卡片网格列数、`/submit`页两栏(表单+侧栏)在窄屏下的堆叠顺序、`/submissions`表格窄屏下是否横向滚动或挤压、长题目名/长文件名的换行是否正常不溢出
4. **长时间等待/弱网体感**（不依赖真实后端故障，只能观察现有UI在"时间拖长"时的表现）：提交一个任务后故意放着不管，持续观察 Waiting 组件的"已等待"计时和"预计还需"文案在超过预估时长后的措辞是否合理(是否只会死板地停在0不再更新)；可用浏览器devtools限速/离线模式模拟网络抖动，观察轮询请求失败时页面是否有提示还是静默卡住
检查点汇总输出：优先截图+简短文字，标注页面+状态+具体问题，不需要重新复述本文档已经列出的"正常路径"结论。

---

## 5. 已知限制 / 给后续 agent 的提醒
- 本文基于当前 git 快照（`actions/web/`），用户提到站点"登录、设计、安全还在改"，实际线上行为可能已经变化，遍历时请先用任务A的第一步核实首页/登录流程是否与本文描述一致，不一致时以实测为准并记录差异。
- 没有做真实的"网络断开"/"会话过期"主动注入（如没有用代理工具强制断网或手动过期cookie），任务D的第4点只能做轻量模拟；如需更严格验证，建议后续单独安排一个专门任务用devtools网络条件或手动清cookie来做。
- 没有拿到比赛真实题目列表，所有"选题"步骤以当前 `/tasks` 实际返回的题目为准，可能只有demo性质的题目可选。
