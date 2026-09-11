package roles

import "testing"

func TestReservedAndSanitize(t *testing.T) {
	if !IsReserved("学生") || !IsReserved("班长") {
		t.Fatal("预置职位应被识别")
	}
	got := SanitizePermissions([]string{"content:write", "admin", "user:manage", "content:write"})
	if len(got) != 2 || got[0] != "content:write" || got[1] != "user:manage" {
		t.Fatalf("白名单过滤结果不对: %#v", got)
	}
	if AssertCustomName("学生").OK {
		t.Fatal("学生不能当自定义职位")
	}
	if !AssertCustomName("文艺委员").OK {
		t.Fatal("合法自定义职位应通过")
	}
}
