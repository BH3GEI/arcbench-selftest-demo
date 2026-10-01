'use client';

import { use, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Icon, MAX_ZIP_MB, Notice, QuotaCard, RequireAuth, useSubmissions, zhError } from '../../_ui';
import { taskDisplayName } from '@/lib/taskVisibility';

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function checkFile(f: File): string | null {
  if (!/\.zip$/i.test(f.name)) return '只能上传 .zip 文件。';
  if (f.size > MAX_ZIP_MB * 1024 * 1024) return `文件 ${formatSize(f.size)}，超过 ${MAX_ZIP_MB} MB 上限。`;
  if (f.size === 0) return '文件是空的。';
  return null;
}

function SubmitForm({ taskId }: { taskId: string }) {
  const { status } = useSession();
  const router = useRouter();
  const { quota } = useSubmissions(status === 'authenticated');
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
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
    setError(null);
    try {
      const form = new FormData();
      form.set('taskId', taskId);
      form.set('file', file);
      const res = await fetch('/api/submit', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(zhError(data.error || `上传失败（${res.status}）`));
        setBusy(false);
        return;
      }
      router.push(`/submissions/${data.id}`);
    } catch (err) {
      setError(`网络错误：${String(err)}`);
      setBusy(false);
    }
  }

  return (
    <main id="main" className="container page">
      <div className="page-head">
        <div>
          <p className="subtle">
            <Link href="/tasks">选择题目</Link> / 上传
          </p>
          <h1 style={{ marginTop: 'var(--s-1)', overflowWrap: 'anywhere' }}>{taskDisplayName(taskId)}</h1>
          <p className="sub">上传 app 的 zip 包，系统会在正式评测环境中构建并运行这道题的测试。</p>
        </div>
      </div>

      <div className="split">
        <form onSubmit={onSubmit} className="card stack" style={{ gap: 'var(--s-5)' }} aria-label="上传自测文件">
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
            <span className="dropzone-icon">{file ? <Icon.file size={24} /> : <Icon.upload size={24} />}</span>
            {file ? (
              <>
                <span className="title">已选择文件</span>
                <span className="file-pill">
                  <span className="name">{file.name}</span>
                  <span className="subtle">{formatSize(file.size)}</span>
                </span>
                <span className="subtle">点击或拖入可更换</span>
              </>
            ) : (
              <>
                <label htmlFor="zip" className="title">
                  把 zip 拖到这里，或<span style={{ color: 'var(--accent)' }}>点击选择文件</span>
                </label>
                <span className="subtle" id="zip-help">
                  仅支持 .zip，最大 {MAX_ZIP_MB} MB
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
            <Notice tone="warning" title="今天的次数已用完">
              明天 UTC 0 点（北京时间 8 点）重置。
            </Notice>
          )}

          <div className="row">
            <button className="btn btn-primary btn-lg" type="submit" disabled={!file || busy || outOfQuota}>
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" /> 正在上传…
                </>
              ) : (
                <>开始自测</>
              )}
            </button>
            {file && !busy && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setFile(null);
                  if (inputRef.current) inputRef.current.value = '';
                }}
              >
                移除文件
              </button>
            )}
            <span className="spacer" />
            {remaining !== null && <span className="subtle">提交后剩余 {Math.max(0, remaining - 1)} 次</span>}
          </div>
        </form>

        <aside className="stack">
          <QuotaCard quota={quota} />
          <section className="card" aria-labelledby="req">
            <h2 id="req" style={{ fontSize: 'var(--fs-md)', marginBottom: 'var(--s-3)' }}>
              zip 格式要求
            </h2>
            <ol className="steps">
              <li>
                <span>
                  zip <strong>根目录</strong>直接放 <code>Dockerfile</code>，不要再套一层文件夹。
                </span>
              </li>
              <li>
                <span>镜像启动后在容器内监听题目要求的端口，提供完整的 app。</span>
              </li>
              <li>
                <span>
                  不要打包 <code>node_modules</code>、<code>.git</code>、构建产物，总大小不超过 {MAX_ZIP_MB} MB。
                </span>
              </li>
            </ol>
            <pre style={{ marginTop: 'var(--s-4)', fontSize: 'var(--fs-xs)' }}>
              {`my-app.zip
├── Dockerfile
├── package.json
└── src/ …`}
            </pre>
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
