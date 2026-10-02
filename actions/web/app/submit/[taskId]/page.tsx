'use client';

import { use, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { MAX_ZIP_MB, Notice, PageHead, Quota, RequireAuth, useSubmissions, zhError } from '../../_ui';
import { taskDisplayName } from '@/lib/taskVisibility';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function checkFile(f: File): string | null {
  if (!/\.zip$/i.test(f.name)) return '仅支持 .zip 文件。';
  if (f.size > MAX_ZIP_MB * 1024 * 1024) return `文件大小 ${formatSize(f.size)}，超过 ${MAX_ZIP_MB} MB 上限。`;
  if (f.size === 0) return '文件为空。';
  return null;
}

// 用 XHR 而不是 fetch：需要上传进度。
function putWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.floor((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`文件上传失败（${xhr.status}），请重试。`));
      }
    };
    xhr.onerror = () => reject(new Error('文件上传失败，请检查网络后重试。'));
    xhr.send(file);
  });
}

function SubmitForm({ taskId }: { taskId: string }) {
  const { status } = useSession();
  const router = useRouter();
  const { quota } = useSubmissions(status === 'authenticated');
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const remaining = quota ? Math.max(0, quota.limit - quota.used) : null;
  const outOfQuota = remaining === 0;

  function pick(f: File | null | undefined) {
    setError(null);
    if (!f) return setFile(null);
    const problem = checkFile(f);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(f);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setProgress(0);
    setError(null);
    try {
      // 1) 申请上传地址（服务端先检查题目、大小和剩余次数，不扣次数）
      const res1 = await fetch('/api/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, size: file.size }),
      });
      const d1 = await res1.json().catch(() => ({}));
      if (!res1.ok) throw new Error(zhError(d1.error || `上传失败（${res1.status}）`));

      // 2) 浏览器直接把 zip 传到存储（不经过站点函数，支持到 50 MB）
      await putWithProgress(d1.uploadUrl, file, setProgress);

      // 3) 服务端复核文件后扣次数并开始评测
      const res2 = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: d1.id }),
      });
      const d2 = await res2.json().catch(() => ({}));
      if (!res2.ok) throw new Error(zhError(d2.error || `提交失败（${res2.status}）`));
      router.push(`/submissions/${d2.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <main id="main" className="wrap">
      <PageHead
        kicker={
          <>
            <Link href="/tasks">提交</Link> / 上传
          </>
        }
        title={taskDisplayName(taskId)}
        lead="上传后，系统在正式评测环境中构建镜像并运行本题测试。"
      >
        <span className="meta">题目 ID {taskId}</span>
      </PageHead>

      <div className="section cols">
        <form onSubmit={onSubmit} className="stack" style={{ gap: 'var(--s-5)' }} aria-label="上传自测文件">
          <div className="label">上传文件</div>
          <div
            className={`dropzone ${over ? 'is-over' : ''} ${file ? 'has-file' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              pick(e.dataTransfer.files?.[0]);
            }}
          >
            <input
              ref={inputRef}
              id="zip"
              type="file"
              accept=".zip,application/zip"
              aria-describedby="zip-help"
              onChange={(e) => pick(e.target.files?.[0])}
              disabled={busy}
            />
            {file ? (
              <>
                <span className="label">已选择</span>
                <span className="file">
                  {file.name} · {formatSize(file.size)}
                </span>
                <span className="subtle">点击或拖入其他文件可替换</span>
              </>
            ) : (
              <>
                <label htmlFor="zip" className="title">
                  拖入 zip 文件，或点击选择
                </label>
                <span className="subtle" id="zip-help">
                  .zip 格式，不超过 {MAX_ZIP_MB} MB
                </span>
              </>
            )}
          </div>

          {error && (
            <Notice tone="danger" title="无法提交">
              {error}
            </Notice>
          )}
          {outOfQuota && (
            <Notice tone="warning" title="今日次数已用完">
              UTC 0:00（北京时间 8:00）重置。
            </Notice>
          )}

          <div className="row">
            <button className="btn btn-primary btn-lg" type="submit" disabled={!file || busy || outOfQuota}>
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" />{' '}
                  {progress !== null && progress < 100 ? `上传中 ${progress}%` : '提交中'}
                </>
              ) : (
                '提交自测'
              )}
            </button>
            {file && !busy && (
              <button
                type="button"
                className="btn btn-lg"
                onClick={() => {
                  setFile(null);
                  if (inputRef.current) inputRef.current.value = '';
                }}
              >
                移除
              </button>
            )}
            <span className="spacer" />
            {remaining !== null && <span className="meta">提交后剩余 {Math.max(0, remaining - 1)} 次</span>}
          </div>
        </form>

        <aside className="stack" style={{ gap: 'var(--s-8)' }}>
          <Quota quota={quota} />
          <section aria-labelledby="req">
            <div className="label" id="req" style={{ marginBottom: 'var(--s-3)' }}>
              zip 格式要求
            </div>
            <table className="dl">
              <tbody>
                <tr>
                  <th scope="row">根目录</th>
                  <td>
                    直接包含 <code>Dockerfile</code>，不要多套一层文件夹。
                  </td>
                </tr>
                <tr>
                  <th scope="row">运行</th>
                  <td>容器启动后监听题目要求的端口。</td>
                </tr>
                <tr>
                  <th scope="row">大小</th>
                  <td>
                    不超过 {MAX_ZIP_MB} MB。不要包含 <code>node_modules</code>、<code>.git</code> 和构建产物。
                  </td>
                </tr>
              </tbody>
            </table>
            <pre style={{ marginTop: 'var(--s-4)' }}>{`app.zip
├── Dockerfile
├── package.json
└── src/`}</pre>
          </section>
        </aside>
      </div>
    </main>
  );
}

export default function SubmitPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = use(params);
  return (
    <RequireAuth>
      <SubmitForm taskId={decodeURIComponent(taskId)} />
    </RequireAuth>
  );
}
