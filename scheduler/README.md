# 调度进程

门户网站继续跑在 Cloudflare Pages Functions 上。这里是 **Go 常驻进程**：轮询、抓取、对外限流这类要活着的事情放这边，不塞进无状态 Worker。

```
class-assistant/
├── cmd/scheduler/     # 入口
├── internal/vault/    # 与 Worker 同一套 AES-GCM Cookie 封存
├── internal/identity/ # 学号必须是本人
├── internal/roles/    # 预置职位不能写进 roles 表
└── internal/ratelimit/# 进程内固定窗口限流
```

## 命令

```bash
go test ./...
go run ./cmd/scheduler once          # CI / 手工：封存自检一轮
go run ./cmd/scheduler student-id 2022103071 2022103071
COOKIE_SECRET=... go run ./cmd/scheduler vault-open < sealed.txt
go run ./cmd/scheduler run           # 长期运行
```

`once` / `run` 需要环境变量 `COOKIE_SECRET` 或 `JWT_SECRET`，与 Pages Secrets 同一套，才能解开 Worker 写入 D1 的教务 Cookie。

抓取（`crawler/`）还没接到真实班级群，会复用这些包，不另起一套规则。
