package identity

import "strings"

// SameStudentID 教务绑定必须对上本人学号。
// 只做 trim 后的精确匹配，不去掉前导零。
func SameStudentID(left, right string) bool {
	a := strings.TrimSpace(left)
	b := strings.TrimSpace(right)
	return a != "" && a == b
}
