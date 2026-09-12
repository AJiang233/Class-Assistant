package ratelimit

import (
	"sync"
	"time"
)

// Limiter 进程内固定窗口限流。调度器、爬虫这种常驻进程该把限流放这里，
// 而不是塞进无状态的 Cloudflare Worker。

type state struct {
	hits    int
	resetAt time.Time
}

type Limiter struct {
	mu   sync.Mutex
	keys map[string]state
}

func New() *Limiter {
	return &Limiter{keys: map[string]state{}}
}

func (l *Limiter) Allow(key string, limit int, window time.Duration) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	cur, ok := l.keys[key]
	if !ok || !cur.resetAt.After(now) {
		l.keys[key] = state{hits: 1, resetAt: now.Add(window)}
		return true
	}
	if cur.hits >= limit {
		return false
	}
	cur.hits++
	l.keys[key] = cur
	return true
}
