package vault

import "testing"

func TestRoundTrip(t *testing.T) {
	env := Env{CookieSecret: "unit-test-cookie-secret"}
	raw := "X-Qz-JSession=abc; INGRESSCOOKIE=xyz"
	sealed, err := Seal(env, raw)
	if err != nil {
		t.Fatal(err)
	}
	if !IsSealed(sealed) {
		t.Fatal("应打上 v1. 前缀")
	}
	if sealed == raw {
		t.Fatal("密文不应等于明文")
	}
	got, err := Open(env, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if got != raw {
		t.Fatalf("解开后不一致: %s", got)
	}
}

func TestPlaintextPassthrough(t *testing.T) {
	got, err := Open(Env{CookieSecret: "x"}, "SESSION=plain")
	if err != nil {
		t.Fatal(err)
	}
	if got != "SESSION=plain" {
		t.Fatal(got)
	}
}

func TestOpenWorkerCiphertext(t *testing.T) {
	// 由 web/backend cookieVault.js 封存，保证调度进程能读 Worker 写下的 D1 记录。
	env := Env{CookieSecret: "compat-secret-for-go"}
	const sealed = "v1.KUzwqjpZfqxf-yi5.CMHC8NlZghnuBlvqXqNIATU37TJ3Ksj4mK5_nTKYqR6MrxMkyzH1LlN9LyDVEvk5Hzp1rQ"
	got, err := Open(env, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if got != "X-Qz-JSession=abc; INGRESSCOOKIE=xyz" {
		t.Fatalf("无法解开 Worker 密文: %s", got)
	}
}

func TestFallbackAfterAddingCookieSecret(t *testing.T) {
	const sealed = "v1.5NovORm6HuRbfrqD.nm693EKMZIOJ7Vzfad9LjheoNMyW4ugo9CEdR-YLGTp782da_re9Jja8XW66NY5L5yIvGQ"
	env := Env{JWTSecret: "jwt-secret-for-vault", CookieSecret: "brand-new-cookie-secret"}
	got, err := Open(env, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if got != "X-Qz-JSession=abc; INGRESSCOOKIE=xyz" {
		t.Fatalf("后加 COOKIE_SECRET 应仍能解开 JWT 派生密文: %s", got)
	}
}
