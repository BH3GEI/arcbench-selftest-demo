# 打包模板

给已经写好 app（通常是 `frontend/` + `backend/`，或任意单体项目）的选手，快速打出一个
自测网站能接受的 zip。

## 用法

1. 把 `Dockerfile.example` 复制到你项目根目录，改名为 `Dockerfile`，按你的项目调整
   （装依赖、build 前端、启动命令）。
2. 把 `.dockerignore` 复制到项目根目录（可选但建议，避免把 `node_modules`、`.git`
   打进镜像）。
3. 确认你的 server 监听 `process.env.PORT`（没有则默认 3000），不要硬编码别的端口。
4. 在项目根目录运行：
   ```bash
   bash pack.sh            # 生成 submission.zip
   bash pack.sh my.zip     # 或者指定文件名
   ```
5. 上传 `pack.sh` 打出来的 zip 到自测网站。

## 打包要求（pack.sh 已经帮你处理，了解一下就行）

- zip 根目录必须直接有 `Dockerfile`。
- 自动排除 `.git`、`node_modules`、已有的 `*.zip`、`.env*`、`.DS_Store`。
- 解压后不超过 50MB、不超过 2000 个文件，不能有跳出目录的路径或软链接。

## 本地先验证一遍（强烈建议）

打包前先在本地确认 app 能正常跑起来，比上传了再排队等报错快得多：

```bash
docker build -t my-app .
docker run --rm -e PORT=3000 -p 3000:3000 my-app
# 另开一个终端
curl -i http://localhost:3000/
```

能正常响应再打包上传。
