package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strings"
)

// 密文格式与 Worker cookieVault.js 一致：v1.<iv>.<ciphertext>，AES-256-GCM。
// 密钥：COOKIE_SECRET，没有则用 JWT_SECRET + ":academic-cookie-v1"。
// 解密按现用密钥再试 JWT 派生，后加 COOKIE_SECRET 不能把旧记录锁死。

const prefix = "v1."

var (
	ErrMissingSecret = errors.New("缺少 COOKIE_SECRET / JWT_SECRET，无法封存教务会话")
	ErrCorrupt       = errors.New("教务会话密文损坏")
)

type Env struct {
	CookieSecret string
	JWTSecret    string
}

func IsSealed(value string) bool {
	return strings.HasPrefix(value, prefix)
}

func secrets(env Env) []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(s string) {
		if s == "" {
			return
		}
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	add(env.CookieSecret)
	if env.JWTSecret != "" {
		add(env.JWTSecret + ":academic-cookie-v1")
	}
	return out
}

func keyFrom(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

func b64Encode(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

func b64Decode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}

func gcmFor(secret string) (cipher.AEAD, error) {
	block, err := aes.NewCipher(keyFrom(secret))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Seal 明文 Cookie → 密文；已经是密文则原样返回。
func Seal(env Env, cookies string) (string, error) {
	if cookies == "" {
		return "", nil
	}
	if IsSealed(cookies) {
		return cookies, nil
	}
	list := secrets(env)
	if len(list) == 0 {
		return "", ErrMissingSecret
	}
	aead, err := gcmFor(list[0])
	if err != nil {
		return "", err
	}
	iv := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}
	ct := aead.Seal(nil, iv, []byte(cookies), nil)
	return prefix + b64Encode(iv) + "." + b64Encode(ct), nil
}

// Open 密文 → 明文；旧的明文记录兼容读取。
func Open(env Env, stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	if !IsSealed(stored) {
		return stored, nil
	}
	parts := strings.Split(stored, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return "", ErrCorrupt
	}
	iv, err := b64Decode(parts[1])
	if err != nil {
		return "", ErrCorrupt
	}
	data, err := b64Decode(parts[2])
	if err != nil {
		return "", ErrCorrupt
	}
	list := secrets(env)
	if len(list) == 0 {
		return "", ErrMissingSecret
	}
	var last error
	for _, secret := range list {
		aead, err := gcmFor(secret)
		if err != nil {
			last = err
			continue
		}
		plain, err := aead.Open(nil, iv, data, nil)
		if err != nil {
			last = err
			continue
		}
		return string(plain), nil
	}
	if last == nil {
		return "", ErrCorrupt
	}
	return "", last
}
