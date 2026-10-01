# arcbench-selftest-demo

> WIP：代码主体已完成，端到端验证进行中。

上传已生成的 app（zip，根目录含 Dockerfile），几分钟内拿到测试结果。结果只给提交者看，不进排行榜。

## 流程
上传 → 校验 → docker build（有超时）→ 全新容器（注入 PORT / BASE_URL，就绪探测）→ Playwright 跑测试包 → 返回通过率、逐条结果、失败截图和报错、app 日志、测试包哈希。

每队每天提交次数有上限（默认 10，可配置）。

## 目录
- `server/` HTTP API 和极简网页
- `cli/selftest.py` 命令行上传和查看结果
- `runner/` 跑 Playwright 的容器（测试执行部分可替换为现有 arcbench runner）
- `examples/` 示例 app（正常版和故意坏的版本）和示例测试
- `scripts/e2e-demo.sh` 端到端演示
- `tests/` 单元测试

## 运行
```
docker compose up
```
详细说明和接入文档补充中。
