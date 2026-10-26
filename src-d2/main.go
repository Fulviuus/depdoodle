package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/d2target"
	"github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/textmeasure"
)

func run() error {
	source, err := io.ReadAll(io.LimitReader(os.Stdin, 8<<20+1))
	if err != nil {
		return err
	}
	if len(source) > 8<<20 {
		return fmt.Errorf("diagram exceeds the input size limit")
	}
	diagram, err := compileSource(string(source))
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"diagram": diagram})
}

func compileSource(source string) (*d2target.Diagram, error) {
	ruler, err := textmeasure.NewRuler()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(log.With(context.Background(), slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))), 30*time.Second)
	defer cancel()
	layout := "tala"
	diagram, _, err := d2lib.Compile(ctx, source, &d2lib.CompileOptions{
		Layout:         &layout,
		Ruler:          ruler,
		LayoutResolver: func(string) (d2graph.LayoutGraph, error) { return d2talalayout.DefaultLayout, nil },
	}, &d2svg.RenderOpts{})
	return diagram, err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
