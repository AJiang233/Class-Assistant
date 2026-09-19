# cmd —— 命令入口

一个目录一个可执行文件。当前只有 `scheduler/`。

```
cmd/
└── scheduler/      # 常驻调度进程
```

## `cmd/scheduler`

长期驻留的 Go 进程，承接「必须一直活着」的事（轮询、抓取、对外限流）；门户本身仍跑在无状态的 Cloudflare Functions 上。

```bash
go run ./cmd/scheduler run                        # 长期运行
go run ./cmd/scheduler once                       # 跑一轮封存自检后退出（CI / 手工验证）
go run ./cmd/scheduler student-id <a> <b>         # 比对两个学号是否同一人
go run ./cmd/scheduler vault-seal                 # 读 stdin 的明文 Cookie，输出密文
go run ./cmd/scheduler vault-open                 # 读 stdin 的密文，输出明文
```

`run` / `once` 与封存类命令需要环境变量 `COOKIE_SECRET` 或 `JWT_SECRET`（与 Pages Secrets 同一套），否则解不开 Worker 写入 D1 的教务 Cookie。

规则实现在 `internal/`（见 [`internal/README.md`](../internal/README.md)），进程本身的行为与现状见 [`scheduler/README.md`](../scheduler/README.md)。
