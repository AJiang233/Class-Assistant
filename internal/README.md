# internal —— 与 Worker 对齐的 Go 规则

`cmd/scheduler`（以及将来的 `crawler/`）共用的内部包。原则只有一条：**同一套规则只写一份** —— 调度进程和门户（`web/backend`）不能各写各的，不然两边的判定迟早对不上。

| 包 | 作用 | 与 Worker 的对应 |
| --- | --- | --- |
| `vault/` | 教务会话 Cookie 的 AES-256-GCM 封存 / 解封 | `web/backend/src/utils/cookieVault.js` |
| `identity/` | 教务绑定必须是本人学号 | `web/backend/src/utils/identity.js` |
| `roles/` | 预置职位不可写入 `roles` 表、自定义权限白名单 | `web/backend/src/utils/permissions.js` |
| `ratelimit/` | 进程内固定窗口限流 | 无（Worker 无状态，限流归常驻进程） |

## `vault/`

- 密文格式与 Worker 的 `cookieVault.js` **一致**：`v1.<iv>.<ciphertext>`，AES-256-GCM
- 密钥取 `COOKIE_SECRET`，缺省回退 `JWT_SECRET` + `":academic-cookie-v1"` 派生；**解密时两个都试** —— 否则后加 `COOKIE_SECRET` 会把旧记录锁死
- 导出：`IsSealed` / `Seal` / `Open`（`Seal` 遇到已是密文的值原样返回；`Open` 兼容读取历史的明文记录）
- 单测里有一条专测「与 Worker 产出的密文互解」（`TestOpenWorkerCiphertext`）和一条「后加密钥不锁死旧记录」（`TestFallbackAfterAddingCookieSecret`）

## `identity/`

- `SameStudentID(left, right)`：只做 trim 后的精确匹配，**不去掉前导零**（学号是标识，不是数字）

## `roles/`

- `IsReserved(name)`：`学生` / `班长` / `团支书` / `学习委员` 是系统预置职位，不允许写进 `roles` 表 —— 否则等于给全班提权
- `SanitizePermissions(list)`：只保留 `content:write` / `user:manage` 两个白名单权限点，去重
- `AssertCustomName(name)`：自定义职位名校验（非空、非预置、不超过 20 字），返回 `Check{OK, Name, Message, Code}`

## `ratelimit/`

- `New()` → `(*Limiter).Allow(key, limit, window)`：进程内固定窗口限流
- 调度器、爬虫这类常驻进程该把限流放这里，而不是塞进无状态的 Cloudflare Worker

## 测试

```bash
go test ./...
```

每个包都有 `*_test.go`，只用标准库 `testing`。`go.mod` 声明 go 1.22，模块路径 `github.com/AJiang233/Class-Assistant`。
