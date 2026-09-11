package roles

import "strings"

// 与 Worker 端 permissions.js 保持同一套规则，避免调度进程和门户各写各的。

var reservedRoles = []string{"学生", "班长", "团支书", "学习委员"}

var allowedPermissions = []string{"content:write", "user:manage"}

func IsReserved(name string) bool {
	n := strings.TrimSpace(name)
	for _, r := range reservedRoles {
		if n == r {
			return true
		}
	}
	return false
}

func SanitizePermissions(list []string) []string {
	out := make([]string, 0, len(list))
	seen := map[string]struct{}{}
	for _, item := range list {
		if !contains(allowedPermissions, item) {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}

type Check struct {
	OK      bool
	Name    string
	Message string
	Code    string
}

func AssertCustomName(name string) Check {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return Check{Message: "职位名称不能为空", Code: "INVALID_ROLE"}
	}
	if IsReserved(trimmed) {
		return Check{Message: "不能把系统预置职位当自定义职位写入权限表", Code: "RESERVED_ROLE"}
	}
	if len([]rune(trimmed)) > 20 {
		return Check{Message: "职位名称最多 20 个字符", Code: "ROLE_TOO_LONG"}
	}
	return Check{OK: true, Name: trimmed}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
