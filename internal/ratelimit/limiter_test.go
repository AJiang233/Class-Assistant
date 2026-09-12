package ratelimit

import (
	"testing"
	"time"
)

func TestAllowWindow(t *testing.T) {
	l := New()
	if !l.Allow("a", 2, time.Hour) || !l.Allow("a", 2, time.Hour) {
		t.Fatal("窗口内前两次应放行")
	}
	if l.Allow("a", 2, time.Hour) {
		t.Fatal("第三次应拒绝")
	}
	if !l.Allow("b", 2, time.Hour) {
		t.Fatal("不同 key 互不影响")
	}
}

func TestWindowReset(t *testing.T) {
	l := New()
	if !l.Allow("a", 1, 20*time.Millisecond) {
		t.Fatal("第一次应放行")
	}
	if l.Allow("a", 1, 20*time.Millisecond) {
		t.Fatal("窗口内第二次应拒绝")
	}
	time.Sleep(30 * time.Millisecond)
	if !l.Allow("a", 1, 20*time.Millisecond) {
		t.Fatal("窗口过期后应重置")
	}
}
