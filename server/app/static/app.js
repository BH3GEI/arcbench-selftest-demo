/* ArcBench 自测 — server channel web UI.
 *
 * Plain JS (no build step) re-implementing the same pages, copy, and status
 * vocabulary as actions/web (Next.js) against this server's REST API. The
 * design tokens and component CSS come from app.css, copied verbatim from
 * actions/web/app/globals.css (see docs/parity.md §7 for how the two stay
 * in sync). Keep copy/labels/status wording identical to
 * actions/web/app/_ui/index.tsx and the page files when either changes.
 */
(function () {
  'use strict';

  var DAILY_LIMIT = 10; // display fallback only; /api/quota is authoritative
  var MAX_ZIP_MB = 50;

  // Keep in sync with actions/web/lib/taskVisibility.ts and
  // server/app/tasks_web.py. /api/tasks already filters + maps server-side;
  // this copy is only needed to render a task's display name on the submit
  // page before the task list has loaded.
  var DISPLAY_NAMES = { 'github-stage-1-req-test': 'GitHub 题 · 第一阶段' };
  function taskDisplayName(taskId) { return DISPLAY_NAMES[taskId] || taskId; }

  var STATUS_META = {
    queued: { label: '排队中', tone: '', live: true },
    running: { label: '运行中', tone: 'pill-info', live: true },
    passed: { label: '全部通过', tone: 'pill-success' },
    failed: { label: '未全部通过', tone: 'pill-danger' },
    error: { label: '运行失败', tone: 'pill-danger' },
    system_error: { label: '系统错误 · 不计次数', tone: 'pill-warning' },
    not_run: { label: '未能运行', tone: 'pill-danger' },
  };

  var SITE_NAME = 'ArcBench 自测';
  function setTitle(title) {
    document.title = !title || title === SITE_NAME ? SITE_NAME : title + ' · ' + SITE_NAME;
  }

  // 评测机返回的英文原因 -> 选手能看懂的中文说明。Keep in sync with
  // actions/web/app/_ui/index.tsx's FAILURE_ZH/failureReason.
  var FAILURE_ZH = [
    [/zip failed validation/i, 'zip 包未通过安全检查',
      'zip 中含有不允许的路径（如 ../ 或绝对路径）、解压后体积过大或文件数过多。请在 app 根目录下重新打包后再提交。'],
    [/no Dockerfile/i, 'zip 根目录缺少 Dockerfile',
      'Dockerfile 需要位于 zip 的根目录，不能放在子文件夹里。打包时请选中 app 目录内的文件，而不是外层文件夹。'],
    [/build exceeded/i, '镜像构建超时', '构建时间超过上限。请精简构建步骤，构建过程中无法访问外网。'],
    [/app build failed/i, '镜像构建失败', '请先在本地运行 docker build 确认能构建成功。构建过程中无法访问外网。'],
    [/did not become ready/i, 'app 未能在限定时间内启动', '请检查启动命令，并确认 app 监听 PORT 环境变量指定的端口。'],
    [/test run exceeded/i, '测试运行超时', '测试整体运行时间超过上限。'],
  ];
  function failureReason(detail) {
    for (var i = 0; i < FAILURE_ZH.length; i++) if (FAILURE_ZH[i][0].test(detail || '')) {
      return { title: FAILURE_ZH[i][1], hint: FAILURE_ZH[i][2] };
    }
    return { title: 'app 未能运行', hint: '镜像构建或启动失败，测试未执行。请检查 Dockerfile 和启动命令。' };
  }

  var ERROR_ZH = [
    [/daily submission limit/i, '今日自测次数已用完，UTC 0:00 重置。'],
    [/overall daily submission limit/i, '今日全站自测名额已满，请次日再试。'],
    [/not a zip/i, '文件不是有效的 zip 格式。'],
    [/zip exceeds/i, '文件超过 ' + MAX_ZIP_MB + ' MB 上限。'],
    [/at least \d+ days old/i, 'GitHub 账号注册时间不足，暂不能使用自测。'],
    [/unknown task/i, '题目不存在。'],
    [/sign in required/i, '登录已失效，请重新登录。'],
    [/could not start grading|upload failed/i, '评测系统出错，本次不计次数，请稍后重试。'],
  ];
  function zhError(msg) {
    for (var i = 0; i < ERROR_ZH.length; i++) if (ERROR_ZH[i][0].test(msg)) return ERROR_ZH[i][1];
    return msg;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function effectiveStatus(s) {
    var st = s.status;
    if (st === 'rejected') return 'system_error';
    var detail = (s.result && s.result.detail) || '';
    if (st === 'error' && /could not start grading|system[_ ]error/i.test(detail)) return 'system_error';
    // app 镜像构建/启动失败、0 条测试执行：与"测试跑了但没全过"区分开，避免误导。
    if ((st === 'error' || st === 'failed') && s.result && s.result.total === 0) return 'not_run';
    return st;
  }
  function isPending(st) { return st === 'queued' || st === 'running'; }

  function usedToday(subs) {
    var day = new Date().toISOString().slice(0, 10);
    var n = 0;
    for (var i = 0; i < subs.length; i++) {
      if (new Date(subs[i].createdAt).toISOString().slice(0, 10) === day && effectiveStatus(subs[i]) !== 'system_error') n++;
    }
    return n;
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function formatDuration(sec) {
    if (sec < 60) return Math.max(0, Math.round(sec)) + ' 秒';
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return s ? m + ' 分 ' + s + ' 秒' : m + ' 分钟';
  }
  function pct(passed, total) { return total > 0 ? Math.round((passed / total) * 100) : 0; }

  function statusBadgeHtml(status) {
    var m = STATUS_META[status] || { label: status, tone: '' };
    return '<span class="pill ' + m.tone + (m.live ? ' pill-live' : '') + '">' + esc(m.label) + '</span>';
  }
  function progressBarHtml(value, tone, label, indeterminate) {
    var cls = 'meter' + (tone ? ' is-' + tone : '') + (indeterminate ? ' is-indeterminate' : '');
    var span = indeterminate ? '<span></span>' : '<span style="width:' + (value || 0) + '%"></span>';
    return '<div class="' + cls + '" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="100"' +
      (indeterminate ? '' : ' aria-valuenow="' + (value || 0) + '"') + '>' + span + '</div>';
  }

  /* ------------------------------------------------------------ data layer */

  // Backend shapes (server/app/main.py) differ in casing/vocab from
  // actions/web's Submission/GradeResult types; these two adapters are the
  // single place that difference is bridged. See docs/parity.md §7.
  function mapResult(r) {
    if (!r) return null;
    return {
      status: r.status === 'done' ? 'passed' : r.status, // 'done'|'failed'|'error' -> 'passed'|'failed'|'error'
      visibility: r.visibility,
      passed: r.passed || 0,
      total: r.total || 0,
      detail: r.detail || '',
      tests: r.tests,
    };
  }
  function mapSubmission(raw) {
    return {
      id: raw.id,
      taskId: raw.task_id,
      status: raw.status === 'done' ? 'passed' : raw.status === 'building' ? 'running' : raw.status,
      createdAt: raw.created_at * 1000,
      updatedAt: raw.updated_at * 1000,
      result: mapResult(raw.result),
    };
  }

  function api(path, opts) {
    opts = Object.assign({ credentials: 'same-origin' }, opts);
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && (data.error || data.detail)) || ('HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function getMe() {
    return fetch('/api/me', { credentials: 'same-origin' }).then(function (res) {
      return res.ok ? res.json() : null;
    });
  }
  function getTasks() { return api('/api/tasks').then(function (d) { return d.tasks; }); }
  function getQuota() { return api('/api/quota'); }
  function getSubmissions() {
    return api('/api/submissions').then(function (list) {
      return list.map(mapSubmission).sort(function (a, b) { return b.createdAt - a.createdAt; });
    });
  }
  function getSubmission(id) { return api('/api/submissions/' + id).then(mapSubmission); }
  function submitZip(taskId, file) {
    var fd = new FormData();
    fd.append('file', file);
    fd.append('task_id', taskId);
    return fetch('/api/submissions', { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var err = new Error(data.error || data.detail || ('HTTP ' + res.status)); err.status = res.status; throw err; }
        return data;
      });
    });
  }

  /** Submission history + today's quota — shared by the home/submit/submissions pages. */
  function loadSubsAndQuota() {
    return Promise.all([getSubmissions(), getQuota().catch(function () { return null; })]).then(function (r) {
      var subs = r[0], q = r[1];
      var quota = q && typeof q.limit === 'number'
        ? { used: typeof q.used === 'number' ? q.used : q.limit - (q.remaining || 0), limit: q.limit }
        : { used: usedToday(subs), limit: DAILY_LIMIT };
      return { subs: subs, quota: quota };
    });
  }

  /* --------------------------------------------------------------- shell */

  var session = null; // {githubId, login} | null
  var pollTimer = null;

  function currentPath() { return location.hash.replace(/^#/, '') || '/'; }
  function go(path) { location.hash = path; }
  // server/app/oauth_github.py always redirects back to "/" after login (no
  // ?next= support) — different from actions/web's NextAuth callbackUrl,
  // which does return the user to where they started. See docs/parity.md §7.
  var LOGIN_HREF = '/auth/github/login';

  var NAV = [
    { href: '#/', label: '概览', match: function (p) { return p === '/'; } },
    { href: '#/tasks', label: '提交', match: function (p) { return p.indexOf('/tasks') === 0 || p.indexOf('/submit') === 0; } },
    { href: '#/submissions', label: '历史记录', match: function (p) { return p.indexOf('/submissions') === 0; } },
  ];

  function renderHeader() {
    var path = currentPath();
    var light = document.documentElement.dataset.theme === 'light';
    var html = '<div class="wrap bar">' +
      '<a href="#/" class="wordmark" aria-label="ArcBench 自测 首页">' +
      '<span class="name">Arc<em>Bench</em></span>' +
      '<span class="sep" aria-hidden="true"></span>' +
      '<span class="sub">SELF-TEST</span></a>';
    if (session) {
      html += '<nav class="nav" aria-label="主导航">' + NAV.map(function (n) {
        return '<a href="' + n.href + '"' + (n.match(path) ? ' aria-current="page"' : '') + '>' + esc(n.label) + '</a>';
      }).join('') + '</nav>';
    }
    html += '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-sm btn-text" id="theme-toggle" aria-pressed="' + light + '" aria-label="' +
      (light ? '切换到暗色模式' : '切换到亮色模式') + '">' +
      (light ? '暗色' : '亮色') + '</button>';
    if (session) {
      html += '<span class="user"><span class="uname">' + esc(session.login) + '</span>' +
        '<a href="/auth/logout" class="btn btn-sm" aria-label="退出 ' + esc(session.login) + '">退出</a></span>';
    }
    html += '</div>';
    var el = document.getElementById('site-header');
    el.innerHTML = html;
    document.getElementById('theme-toggle').onclick = toggleTheme;
  }

  function toggleTheme() {
    var next = document.documentElement.dataset.theme !== 'light';
    if (next) document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('theme', next ? 'light' : 'dark'); } catch (e) {}
    renderHeader();
  }

  function renderOfflineNotice() {
    var el = document.getElementById('offline-notice');
    if (!el) return;
    el.innerHTML = navigator.onLine
      ? ''
      : '<div class="offline-notice" role="status" aria-live="polite">网络连接异常，当前显示的数据可能不是最新。</div>';
  }

  function renderFooter() {
    document.getElementById('site-footer').innerHTML = '<div class="wrap bar">' +
      '<span class="mark">Arc<em>Bench</em> 自测</span>' +
      '<span class="meta">自测结果仅本人可见，不计入正式成绩</span></div>';
  }

  function pageHeadHtml(kicker, title, lead, actionsHtml) {
    return '<div class="page-head">' +
      '<div class="kicker">' + kicker + '</div>' +
      '<h1>' + esc(title) + '</h1>' +
      (lead ? '<p class="lead">' + lead + '</p>' : '') +
      (actionsHtml ? '<div class="actions">' + actionsHtml + '</div>' : '') +
      '</div>';
  }
  function noticeHtml(tone, title, body) {
    return '<div class="notice notice-' + tone + '"' + (tone === 'danger' ? ' role="alert"' : '') + '>' +
      (title ? '<strong>' + esc(title) + '</strong>' : '') +
      (body ? '<div>' + body + '</div>' : '') + '</div>';
  }
  function signInButtonHtml(large) {
    return '<a href="' + LOGIN_HREF + '" class="btn btn-primary' + (large ? ' btn-lg' : '') + '">使用 GitHub 登录</a>';
  }
  function quotaHtml(quota) {
    if (!quota) return '<div class="skeleton" style="height:96px"></div>';
    var remaining = Math.max(0, quota.limit - quota.used);
    var ticks = '';
    for (var i = 0; i < quota.limit; i++) ticks += '<span class="' + (i < quota.used ? 'used' : '') + '"></span>';
    return '<section aria-labelledby="quota-title">' +
      '<div class="label" id="quota-title">今日剩余次数</div>' +
      '<div class="quota-num" style="margin-top:var(--s-3)">' +
      '<span' + (remaining === 0 ? ' class="tone-danger"' : '') + '>' + remaining + '</span>' +
      '<small>/ ' + quota.limit + '</small></div>' +
      '<div class="ticks" aria-hidden="true">' + ticks + '</div>' +
      '<p class="subtle" style="margin-top:var(--s-3)">每日 UTC 0:00（北京时间 8:00）重置。系统错误的提交不计次数。</p>' +
      '</section>';
  }
  function rulesTableHtml() {
    return '<table class="dl"><tbody>' +
      '<tr><th scope="row">成绩</th><td>自测结果仅本人可见，不计入正式成绩和排行榜，不影响正式提交。</td></tr>' +
      '<tr><th scope="row">次数</th><td>每人每天 ' + DAILY_LIMIT + ' 次，UTC 0:00（北京时间 8:00）重置。评测系统自身出错的提交不计次数。</td></tr>' +
      '<tr><th scope="row">环境</th><td>与正式评测使用相同的容器镜像和测试用例。</td></tr>' +
      '<tr><th scope="row">提交格式</th><td>一个 <code>.zip</code> 文件，根目录包含 <code>Dockerfile</code>，不超过 ' + MAX_ZIP_MB + ' MB。</td></tr>' +
      '<tr><th scope="row">流程</th><td>选择题目，上传 zip，等待构建和测试完成，查看逐条测试结果。</td></tr>' +
      '</tbody></table>';
  }

  function requireAuth(render) {
    if (session) return render();
    setTitle('需要登录');
    main().innerHTML = pageHeadHtml('自测', '需要登录', '登录后可提交自测并查看本人的提交记录。', signInButtonHtml(false));
  }
  function main() { return document.getElementById('main'); }
  function clearPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  /* ------------------------------------------------------------- 首页 */

  function renderHome() {
    setTitle('ArcBench 自测');
    if (!session) {
      main().innerHTML =
        pageHeadHtml('自测通道', 'ArcBench 自测',
          '上传 app 的 zip 包，在正式评测环境中运行题目测试并查看结果。自测结果不计入成绩。',
          signInButtonHtml(true) + '<span class="meta">仅读取 GitHub 公开资料，用于识别选手和统计次数</span>') +
        '<section class="section" aria-labelledby="rules">' +
        '<div class="section-title"><h2 id="rules">说明</h2></div>' +
        rulesTableHtml() + '</section>';
      return;
    }
    main().innerHTML = pageHeadHtml('概览', 'ArcBench 自测', '选择题目并上传 zip，结果通常在几分钟内返回。',
      '<a href="#/tasks" class="btn btn-primary btn-lg">提交自测</a>' +
      '<a href="#/submissions" class="btn btn-lg">历史记录</a>') +
      '<div class="section cols">' +
      '<section aria-labelledby="recent">' +
      '<div class="section-title"><h2 id="recent">最近提交</h2><span class="spacer"></span>' +
      '<a href="#/submissions" class="meta">全部记录 →</a></div>' +
      '<div id="recent-body"><div class="skeleton" style="height:160px"></div></div>' +
      '</section>' +
      '<aside class="stack" style="gap:var(--s-8)">' +
      '<div id="home-quota"><div class="skeleton" style="height:96px"></div></div>' +
      '<section aria-labelledby="rules"><div class="label" id="rules" style="margin-bottom:var(--s-3)">说明</div>' +
      rulesTableHtml() + '</section></aside></div>';

    loadSubsAndQuota().then(function (r) {
      document.getElementById('home-quota').innerHTML = quotaHtml(r.quota);
      var recent = r.subs.slice(0, 5);
      var body = document.getElementById('recent-body');
      if (!body) return;
      if (recent.length === 0) { body.innerHTML = '<p class="empty">暂无提交记录。</p>'; return; }
      body.innerHTML = '<table class="table responsive"><thead><tr>' +
        '<th scope="col">题目</th><th scope="col">通过</th><th scope="col">状态</th><th scope="col">提交时间</th>' +
        '</tr></thead><tbody>' + recent.map(function (s) {
          return '<tr><td><a href="#/submissions/' + s.id + '" class="rowlink">' + esc(taskDisplayName(s.taskId)) + '</a></td>' +
            '<td class="num">' + (s.result && s.result.total > 0 ? s.result.passed + ' / ' + s.result.total : '—') + '</td>' +
            '<td>' + statusBadgeHtml(effectiveStatus(s)) + '</td>' +
            '<td class="meta" data-wide>' + esc(formatTime(s.createdAt)) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function (e) {
      var body = document.getElementById('recent-body');
      if (body) body.innerHTML = noticeHtml('danger', '加载失败', esc(zhError(String(e.message || e))));
    });
  }

  /* ------------------------------------------------------------- 题目列表 */

  function renderTasks() {
    requireAuth(function () {
      setTitle('选择题目');
      main().innerHTML = pageHeadHtml('提交', '选择题目', '选择要自测的题目，下一步上传 zip。') +
        '<section class="section" aria-labelledby="list"><h2 id="list" class="sr-only">题目列表</h2>' +
        '<div id="tasks-body"><div class="skeleton" style="height:160px"></div></div></section>';
      getTasks().then(function (tasks) {
        var body = document.getElementById('tasks-body');
        if (!body) return;
        if (tasks.length === 0) { body.innerHTML = '<p class="empty">暂无开放自测的题目。</p>'; return; }
        body.innerHTML = '<table class="table"><thead><tr>' +
          '<th scope="col" style="width:64px">序号</th><th scope="col">题目</th><th scope="col">ID</th>' +
          '<th scope="col" class="go">操作</th></tr></thead><tbody>' + tasks.map(function (t, i) {
            var href = '#/submit/' + encodeURIComponent(t.id);
            return '<tr><td class="num meta">' + String(i + 1).padStart(2, '0') + '</td>' +
              '<td><a href="' + href + '" class="rowlink">' + esc(t.displayName) + '</a></td>' +
              '<td class="meta">' + esc(t.id) + '</td>' +
              '<td class="go"><a href="' + href + '" class="btn btn-sm" aria-label="上传到 ' + esc(t.displayName) + '">上传 →</a></td></tr>';
          }).join('') + '</tbody></table>';
      }).catch(function (e) {
        var body = document.getElementById('tasks-body');
        if (body) body.innerHTML = noticeHtml('danger', '题目列表加载失败', esc(zhError(String(e.message || e))));
      });
    });
  }

  /* ------------------------------------------------------------- 上传页 */

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  function checkFile(f) {
    if (!/\.zip$/i.test(f.name)) return '仅支持 .zip 文件。';
    if (f.size > MAX_ZIP_MB * 1024 * 1024) return '文件大小 ' + formatSize(f.size) + '，超过 ' + MAX_ZIP_MB + ' MB 上限。';
    if (f.size === 0) return '文件为空。';
    return null;
  }

  function renderSubmit(taskId) {
    requireAuth(function () {
      var file = null, busy = false;
      setTitle(taskDisplayName(taskId));
      main().innerHTML = pageHeadHtml(
        '<a href="#/tasks">提交</a> / 上传', taskDisplayName(taskId),
        '上传后，系统在正式评测环境中构建镜像并运行本题测试。',
        '<span class="meta">题目 ID ' + esc(taskId) + '</span>') +
        '<div class="section cols">' +
        '<form id="submit-form" class="stack" style="gap:var(--s-5)" aria-label="上传自测文件">' +
        '<div class="label">上传文件</div>' +
        '<div class="dropzone" id="dropzone">' +
        '<input id="zip" type="file" accept=".zip,application/zip" aria-describedby="zip-help">' +
        '<div id="dropzone-content" style="display:contents">' +
        '<label for="zip" class="title">拖入 zip 文件，或点击选择</label>' +
        '<span class="subtle" id="zip-help">.zip 格式，不超过 ' + MAX_ZIP_MB + ' MB</span>' +
        '</div></div>' +
        '<div id="submit-error"></div>' +
        '<div id="submit-quota-warning"></div>' +
        '<div class="row">' +
        '<button class="btn btn-primary btn-lg" type="submit" id="submit-btn" disabled>提交自测</button>' +
        '<button type="button" class="btn btn-lg" id="remove-btn" style="display:none">移除</button>' +
        '<span class="spacer"></span><span class="meta" id="remaining-note"></span>' +
        '</div></form>' +
        '<aside class="stack" style="gap:var(--s-8)">' +
        '<div id="submit-quota"><div class="skeleton" style="height:96px"></div></div>' +
        '<section aria-labelledby="req"><div class="label" id="req" style="margin-bottom:var(--s-3)">zip 格式要求</div>' +
        '<table class="dl"><tbody>' +
        '<tr><th scope="row">根目录</th><td>直接包含 <code>Dockerfile</code>，不要多套一层文件夹。</td></tr>' +
        '<tr><th scope="row">运行</th><td>容器启动后监听题目要求的端口。</td></tr>' +
        '<tr><th scope="row">大小</th><td>不超过 ' + MAX_ZIP_MB + ' MB。不要包含 <code>node_modules</code>、<code>.git</code> 和构建产物。</td></tr>' +
        '</tbody></table>' +
        '<pre style="margin-top:var(--s-4)">app.zip\n├── Dockerfile\n├── package.json\n└── src/</pre>' +
        '</section></aside></div>';

      var quota = null;
      function remaining() { return quota ? Math.max(0, quota.limit - quota.used) : null; }
      function syncButtons() {
        var rem = remaining();
        document.getElementById('submit-btn').disabled = !file || busy || rem === 0;
        document.getElementById('remove-btn').style.display = file && !busy ? '' : 'none';
        var note = document.getElementById('remaining-note');
        if (note) note.textContent = rem !== null ? ('提交后剩余 ' + Math.max(0, rem - 1) + ' 次') : '';
        var warn = document.getElementById('submit-quota-warning');
        if (warn) warn.innerHTML = rem === 0 ? noticeHtml('warning', '今日次数已用完', 'UTC 0:00（北京时间 8:00）重置。') : '';
      }

      loadSubsAndQuota().then(function (r) {
        quota = r.quota;
        var q = document.getElementById('submit-quota');
        if (q) q.innerHTML = quotaHtml(quota);
        syncButtons();
      }).catch(function () {});

      var zipInput = document.getElementById('zip');
      var dropzone = document.getElementById('dropzone');
      var errorBox = document.getElementById('submit-error');

      function pick(f) {
        errorBox.innerHTML = '';
        if (!f) { file = null; renderPicked(); return; }
        var problem = checkFile(f);
        if (problem) { file = null; errorBox.innerHTML = noticeHtml('danger', '无法提交', esc(problem)); renderPicked(); return; }
        file = f;
        renderPicked();
      }
      function renderPicked() {
        var content = document.getElementById('dropzone-content');
        dropzone.classList.toggle('has-file', Boolean(file));
        content.innerHTML = file
          ? '<span class="label">已选择</span><span class="file">' + esc(file.name) + ' · ' + formatSize(file.size) + '</span>' +
            '<span class="subtle">点击或拖入其他文件可替换</span>'
          : '<label for="zip" class="title">拖入 zip 文件，或点击选择</label>' +
            '<span class="subtle" id="zip-help">.zip 格式，不超过 ' + MAX_ZIP_MB + ' MB</span>';
        syncButtons();
      }
      zipInput.onchange = function (e) { pick(e.target.files && e.target.files[0]); };
      dropzone.ondragover = function (e) { e.preventDefault(); dropzone.classList.add('is-over'); };
      dropzone.ondragleave = function () { dropzone.classList.remove('is-over'); };
      dropzone.ondrop = function (e) {
        e.preventDefault();
        dropzone.classList.remove('is-over');
        pick(e.dataTransfer.files && e.dataTransfer.files[0]);
      };
      document.getElementById('remove-btn').onclick = function () {
        file = null;
        zipInput.value = '';
        renderPicked();
      };
      document.getElementById('submit-form').onsubmit = function (e) {
        e.preventDefault();
        if (!file) return;
        busy = true;
        errorBox.innerHTML = '';
        var btn = document.getElementById('submit-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> 上传中';
        submitZip(taskId, file).then(function (data) {
          go('/submissions/' + data.id);
        }).catch(function (err) {
          busy = false;
          btn.innerHTML = '提交自测';
          errorBox.innerHTML = noticeHtml('danger', '无法提交', esc(zhError(err.message || String(err))));
          syncButtons();
        });
      };
    });
  }

  /* ------------------------------------------------------------- 历史记录 */

  function renderSubmissions() {
    requireAuth(function () {
      setTitle('提交记录');
      main().innerHTML = pageHeadHtml('历史记录', '提交记录', '本人全部自测提交。',
        '<a href="#/tasks" class="btn btn-primary">提交自测</a>') +
        '<section class="section" aria-labelledby="list"><h2 id="list" class="sr-only">提交列表</h2>' +
        '<div id="subs-body"><div class="skeleton" style="height:240px"></div></div></section>';

      loadSubsAndQuota().then(function (r) {
        var lead = main().querySelector('.lead');
        if (lead) {
          var rem = Math.max(0, r.quota.limit - r.quota.used);
          lead.textContent = '本人全部自测提交。今日剩余 ' + rem + ' / ' + r.quota.limit + ' 次。';
        }
        var body = document.getElementById('subs-body');
        if (!body) return;
        if (r.subs.length === 0) {
          body.innerHTML = '<div class="empty"><p>暂无提交记录。</p><a href="#/tasks" class="btn">提交自测</a></div>';
          return;
        }
        body.innerHTML = '<table class="table responsive"><thead><tr>' +
          '<th scope="col">题目</th><th scope="col">状态</th><th scope="col" style="width:28%">通过</th>' +
          '<th scope="col">提交时间</th><th scope="col" class="go"><span class="sr-only">操作</span></th>' +
          '</tr></thead><tbody>' + r.subs.map(function (s) {
            var st = effectiveStatus(s);
            var rr = s.result;
            var p = rr ? pct(rr.passed, rr.total) : 0;
            var all = rr && rr.total > 0 && rr.passed === rr.total;
            var scoreCell = rr && rr.total > 0 && st !== 'system_error'
              ? '<span class="row" style="gap:var(--s-3);flex-wrap:nowrap"><span class="num" style="min-width:56px">' +
                rr.passed + ' / ' + rr.total + '</span><span style="flex:1">' +
                progressBarHtml(p, all ? 'success' : rr.passed === 0 ? 'danger' : undefined, '通过率 ' + p + '%') + '</span></span>'
              : '<span class="meta">' + (isPending(st) ? '评测中' : '—') + '</span>';
            return '<tr><td><a href="#/submissions/' + s.id + '" class="rowlink">' + esc(taskDisplayName(s.taskId)) + '</a></td>' +
              '<td>' + statusBadgeHtml(st) + '</td>' +
              '<td data-wide>' + scoreCell + '</td>' +
              '<td class="meta" data-wide>' + esc(formatTime(s.createdAt)) + '</td>' +
              '<td class="go"><a href="#/submissions/' + s.id + '" class="meta" aria-label="查看结果">查看 →</a></td></tr>';
          }).join('') + '</tbody></table>';
      }).catch(function (e) {
        var body = document.getElementById('subs-body');
        if (body) body.innerHTML = noticeHtml('danger', '加载失败', esc(zhError(String(e.message || e))));
      });
    });
  }

  /* ------------------------------------------------------------- 结果详情 */

  var POLL_MS = 4000;
  var TYPICAL_SECONDS = 5 * 60;

  function renderSubmissionDetail(id) {
    requireAuth(function () {
      setTitle('结果');
      main().setAttribute('aria-busy', 'true');
      main().innerHTML = '<div class="page-head"><div class="skeleton" style="height:14px;width:120px"></div>' +
        '<div class="skeleton" style="height:56px;width:320px;margin-top:24px"></div></div>' +
        '<span class="sr-only">正在加载结果</span>';
      poll();
    });

    function poll() {
      getSubmission(id).then(function (s) {
        main().removeAttribute('aria-busy');
        renderDetail(s);
        if (isPending(effectiveStatus(s))) pollTimer = setTimeout(poll, POLL_MS);
      }).catch(function (e) {
        main().removeAttribute('aria-busy');
        var msg = e.status === 404 ? '提交记录不存在。' : zhError(e.message || String(e));
        main().innerHTML = pageHeadHtml('<a href="#/submissions">历史记录</a>', '无法加载结果') +
          '<div class="section">' + noticeHtml('danger', undefined, esc(msg)) + '</div>';
      });
    }

    function renderDetail(s) {
      var st = effectiveStatus(s);
      var r = s.result;
      var hidden = Boolean(r && (r.visibility === 'hidden' || !r.tests));
      var resubmit = '#/submit/' + encodeURIComponent(s.taskId);
      setTitle(taskDisplayName(s.taskId) + ' 结果');

      var html = pageHeadHtml(
        '<a href="#/submissions">历史记录</a> / 结果', taskDisplayName(s.taskId), null,
        statusBadgeHtml(st) +
        '<span class="meta">提交于 ' + esc(formatTime(s.createdAt)) + '</span>' +
        '<span class="meta">编号 ' + esc(s.id.slice(0, 8)) + '</span>' +
        '<span class="meta">题目 ID ' + esc(s.taskId) + '</span>' +
        '<span class="spacer"></span>' +
        '<a href="' + resubmit + '" class="btn">再次提交</a>');

      if (isPending(st)) html += waitingHtml(s, st);

      if (st === 'system_error') {
        html += '<section class="section stack">' +
          noticeHtml('warning', '评测系统出错，本次不计次数，请稍后重试', '问题出在评测系统，与提交的 app 无关。') +
          (r && r.detail ? '<pre>' + esc(r.detail) + '</pre>' : '') +
          '<div><a href="' + resubmit + '" class="btn btn-primary">重新提交</a></div></section>';
      }

      if (st === 'not_run' && r) {
        var reason = failureReason(r.detail);
        html += '<section class="section stack">' +
          noticeHtml('danger', reason.title, esc(reason.hint) + ' 本次计入当日次数。') +
          (r.detail ? '<pre>' + esc(r.detail) + '</pre>' : '') +
          '<div><a href="' + resubmit + '" class="btn btn-primary">修改后重新提交</a></div></section>';
      }

      if (r && !isPending(st) && st !== 'system_error' && r.total > 0) html += scoreHtml(s, hidden);
      if (r && !hidden && r.tests && r.tests.length > 0) html += testsShellHtml();

      main().innerHTML = html;

      if (r && !hidden && r.tests && r.tests.length > 0) wireTests(r.tests);
    }

    function waitingHtml(s, st) {
      var elapsed = (Date.now() - s.createdAt) / 1000;
      var eta = Math.max(0, TYPICAL_SECONDS - elapsed);
      var queued = st === 'queued';
      var steps = ['已上传', '排队', '构建镜像', '运行测试', '生成结果'];
      var active = queued ? 1 : 3;
      return '<section class="section" aria-live="polite" aria-labelledby="wait-title">' +
        '<div class="section-title"><h2 id="wait-title">' + (queued ? '排队中' : '评测中') + '</h2></div>' +
        '<table class="dl" style="max-width:560px"><tbody>' +
        '<tr><th scope="row">当前阶段</th><td>' + (queued ? '等待评测机' : '构建镜像并运行测试') + '</td></tr>' +
        '<tr><th scope="row">已等待</th><td class="mono">' + esc(formatDuration(elapsed)) + '</td></tr>' +
        '<tr><th scope="row">预计剩余</th><td class="mono">' +
        (eta > 0 ? '约 ' + esc(formatDuration(Math.ceil(eta / 30) * 30)) : '超出常规耗时，请继续等待') + '</td></tr>' +
        '</tbody></table>' +
        '<ol class="steps-line" aria-label="评测进度">' + steps.map(function (label, i) {
          var cls = i < active ? 'done' : i === active ? 'active' : '';
          return '<li class="' + cls + '"' + (i === active ? ' aria-current="step"' : '') + '>' + esc(label) + '</li>';
        }).join('') + '</ol>' +
        '<p class="subtle" style="margin-top:var(--s-5)">页面每 ' + (POLL_MS / 1000) + ' 秒自动刷新。可离开本页，稍后在历史记录中查看结果。</p>' +
        '</section>';
    }

    function scoreHtml(s, hidden) {
      var r = s.result;
      var p = pct(r.passed, r.total);
      var all = r.total > 0 && r.passed === r.total;
      var tone = all ? 'success' : r.passed === 0 ? 'danger' : undefined;
      return '<section class="section" aria-labelledby="score-title">' +
        '<div class="section-title"><h2 id="score-title">得分</h2></div>' +
        '<div class="score"><div class="score-num" aria-label="通过 ' + r.passed + ' 个，共 ' + r.total + ' 个">' +
        '<span' + (all ? ' class="tone-success"' : '') + '>' + r.passed + '</span><span class="d">/ ' + r.total + '</span></div>' +
        '<div class="score-side"><span class="pct">通过率 ' + p + '% · ' + (all ? '全部通过' : (r.total - r.passed) + ' 个未通过') + '</span>' +
        progressBarHtml(p, tone, '通过率 ' + p + '%') + '</div></div>' +
        (r.detail ? '<p class="subtle" style="margin-top:var(--s-4)">' + esc(r.detail) + '</p>' : '') +
        (hidden ? '<div style="margin-top:var(--s-5)">' + noticeHtml('info', '隐藏测试', '本题只公布通过数量，不显示每条测试的内容和报错。') + '</div>' : '') +
        '</section>';
    }

    function testsShellHtml() {
      return '<section class="section" aria-labelledby="tests-title">' +
        '<div class="section-title"><h2 id="tests-title">测试明细</h2><span class="spacer"></span>' +
        '<span class="meta">点击未通过的测试查看报错和截图</span></div>' +
        '<div class="tabs" role="group" aria-label="筛选测试" id="test-tabs"></div>' +
        '<div id="test-rows"></div></section>';
    }

    function testRowHtml(t) {
      var shots = (t.screenshots || []).concat(t.screenshot ? [t.screenshot] : []);
      var head = '<span class="t-state"><span class="pill ' + (t.ok ? 'pill-success' : 'pill-danger') + '">' +
        (t.ok ? 'PASS' : 'FAIL') + '</span></span>' +
        '<span class="t-title">' + esc(t.title) + '</span>' +
        (typeof t.durationMs === 'number' ? '<span class="meta">' + (t.durationMs / 1000).toFixed(1) + 's</span>' : '');
      var hasBody = Boolean((!t.ok && t.error) || shots.length);
      if (!hasBody) return '<div class="test"><div class="test-head">' + head + '</div></div>';
      var body = (!t.ok && t.error ? '<span class="label">报错</span><pre>' + esc(t.error) + '</pre>' : '') +
        (shots.length ? '<span class="label">截图</span>' : '') +
        shots.map(function (src, i) {
          var url = '/api/submissions/' + id + '/artifact?path=' + encodeURIComponent(src);
          var alt = '测试「' + t.title + '」截图 ' + (i + 1);
          return '<span class="shot" data-src="' + esc(url) + '" data-alt="' + esc(alt) + '"></span>';
        }).join('');
      return '<details class="test"><summary>' + head + '<span class="toggle" aria-hidden="true"></span></summary>' +
        '<div class="test-body">' + body + '</div></details>';
    }

    function mountShot(container) {
      var src = container.getAttribute('data-src');
      var alt = container.getAttribute('data-alt');
      function showImage() {
        container.innerHTML = '';
        var a = document.createElement('a');
        a.href = src;
        a.target = '_blank';
        a.rel = 'noreferrer';
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = alt;
        img.onerror = showBroken;
        img.src = src;
        a.appendChild(img);
        container.appendChild(a);
      }
      function showBroken() {
        container.innerHTML = '';
        var span = document.createElement('span');
        span.className = 'shot-broken';
        var text = document.createElement('span');
        text.textContent = '截图加载失败，可能是网络连接异常';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm';
        btn.textContent = '重试';
        btn.onclick = showImage;
        span.appendChild(text);
        span.appendChild(btn);
        container.appendChild(span);
      }
      showImage();
    }

    function wireTests(tests) {
      var failed = tests.filter(function (t) { return !t.ok; }).length;
      var filter = failed ? 'fail' : 'all';
      var opts = [['fail', '未通过 ' + failed], ['pass', '通过 ' + (tests.length - failed)], ['all', '全部 ' + tests.length]];

      function renderTabs() {
        document.getElementById('test-tabs').innerHTML = opts.map(function (o) {
          return '<button type="button" aria-pressed="' + (filter === o[0]) + '" data-f="' + o[0] + '">' + esc(o[1]) + '</button>';
        }).join('');
        Array.prototype.forEach.call(document.querySelectorAll('#test-tabs button'), function (btn) {
          btn.onclick = function () { filter = btn.getAttribute('data-f'); renderTabs(); renderRows(); };
        });
      }
      function renderRows() {
        var shown = tests.filter(function (t) { return filter === 'all' ? true : filter === 'fail' ? !t.ok : t.ok; });
        var rows = document.getElementById('test-rows');
        rows.innerHTML = shown.length === 0
          ? '<p class="empty">' + (filter === 'fail' ? '没有未通过的测试。' : '无测试。') + '</p>'
          : shown.map(testRowHtml).join('');
        Array.prototype.forEach.call(rows.querySelectorAll('.shot'), mountShot);
      }
      renderTabs();
      renderRows();
    }
  }

  /* ------------------------------------------------------------- router */

  function render() {
    clearPoll();
    var path = currentPath();
    renderHeader();
    var m;
    if (path === '/' || path === '') renderHome();
    else if (path === '/tasks') renderTasks();
    else if ((m = path.match(/^\/submit\/(.+)$/))) renderSubmit(decodeURIComponent(m[1]));
    else if (path === '/submissions') renderSubmissions();
    else if ((m = path.match(/^\/submissions\/([^/]+)$/))) renderSubmissionDetail(m[1]);
    else { setTitle('页面不存在'); main().innerHTML = pageHeadHtml('', '页面不存在', '请从导航重新开始。'); }
    main().focus && main();
  }

  window.addEventListener('hashchange', render);
  window.addEventListener('online', renderOfflineNotice);
  window.addEventListener('offline', renderOfflineNotice);

  getMe().then(function (me) {
    session = me && !me.error ? me : null;
  }).catch(function () { session = null; }).then(function () {
    renderFooter();
    renderOfflineNotice();
    render();
  });
})();
