package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/AJiang233/Class-Assistant/internal/identity"
	"github.com/AJiang233/Class-Assistant/internal/vault"
)

// 长期驻留进程。门户仍跑在 Cloudflare Worker 上；
// 轮询、抓取、限流这类要活着的事情放这里，不塞进无状态 Functions。

func main() {
	if len(os.Args) < 2 {
		usage(os.Stderr)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun()
	case "once":
		err = cmdOnce()
	case "vault-seal":
		err = cmdVaultSeal()
	case "vault-open":
		err = cmdVaultOpen()
	case "student-id":
		err = cmdStudentID(os.Args[2:])
	case "help", "-h", "--help":
		usage(os.Stdout)
		return
	default:
		fmt.Fprintf(os.Stderr, "未知命令: %s\n", os.Args[1])
		usage(os.Stderr)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func usage(w io.Writer) {
	fmt.Fprint(w, `调度进程（Go）

用法:
  scheduler run          长期运行，按间隔做封存自检
  scheduler once         跑一轮自检后退出（给 CI / 手工验证）
  scheduler vault-seal   从标准输入读明文，写出密文
  scheduler vault-open   从标准输入读密文，写出明文
  scheduler student-id A B
`)
}

func envFromOS() vault.Env {
	return vault.Env{
		CookieSecret: os.Getenv("COOKIE_SECRET"),
		JWTSecret:    os.Getenv("JWT_SECRET"),
	}
}

func cmdOnce() error {
	env := envFromOS()
	raw := "scheduler-selftest"
	sealed, err := vault.Seal(env, raw)
	if err != nil {
		return fmt.Errorf("封存自检失败: %w", err)
	}
	got, err := vault.Open(env, sealed)
	if err != nil {
		return fmt.Errorf("解封自检失败: %w", err)
	}
	if got != raw {
		return fmt.Errorf("封存自检明文不一致")
	}
	fmt.Println("封存自检通过")
	return nil
}

func cmdRun() error {
	if err := cmdOnce(); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	fmt.Println("调度进程已启动，每小时做一次封存自检。Ctrl+C 退出。")
	for {
		select {
		case <-ctx.Done():
			fmt.Println("调度进程退出")
			return nil
		case <-tick.C:
			if err := cmdOnce(); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
		}
	}
}

func readStdin() (string, error) {
	b, err := io.ReadAll(bufio.NewReader(os.Stdin))
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(b), "\r\n"), nil
}

func cmdVaultSeal() error {
	raw, err := readStdin()
	if err != nil {
		return err
	}
	out, err := vault.Seal(envFromOS(), raw)
	if err != nil {
		return err
	}
	fmt.Print(out)
	return nil
}

func cmdVaultOpen() error {
	raw, err := readStdin()
	if err != nil {
		return err
	}
	out, err := vault.Open(envFromOS(), raw)
	if err != nil {
		return err
	}
	fmt.Print(out)
	return nil
}

func cmdStudentID(args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("用法: scheduler student-id <门户学号> <教务学号>")
	}
	if !identity.SameStudentID(args[0], args[1]) {
		return fmt.Errorf("学号不一致")
	}
	fmt.Println("学号一致")
	return nil
}
