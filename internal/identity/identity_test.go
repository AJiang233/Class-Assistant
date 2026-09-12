package identity

import "testing"

func TestSameStudentID(t *testing.T) {
	if !SameStudentID(" 2022103071 ", "2022103071") {
		t.Fatal("trim 后应视为同一学号")
	}
	if SameStudentID("2022103071", "2022103072") {
		t.Fatal("不同学号不能通过")
	}
	if SameStudentID("", "") {
		t.Fatal("空学号不能通过")
	}
}
