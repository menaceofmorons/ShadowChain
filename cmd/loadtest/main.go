package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"

	"github.com/menaceofmorons/ShadowChain/cmd/loadtest/config"
	"github.com/menaceofmorons/ShadowChain/cmd/loadtest/scenario"
)

const defaultConfigPath = "cmd/loadtest/contention.config.json"

const (
	exitOK      = 0
	exitFailed  = 1
	exitUsage   = 2
	exitRunFail = 3
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("loadtest", flag.ContinueOnError)
	fs.SetOutput(stderr)
	flags := config.RegisterFlags(fs, defaultConfigPath)
	short := fs.Bool("short", false, "run the short CI profile")
	asJSON := fs.Bool("json", false, "write the result as JSON")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	cfg, err := flags.Load()
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return exitUsage
	}
	opts := scenario.FullOptions(cfg, flags.Path)
	if *short {
		opts = scenario.ShortOptions(cfg, flags.Path)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	result, err := scenario.Run(ctx, opts)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return exitRunFail
	}
	write := result.WriteText
	if *asJSON {
		write = result.WriteJSON
	}
	if err := write(stdout); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return exitRunFail
	}
	if !result.Healthy() {
		return exitFailed
	}
	return exitOK
}
