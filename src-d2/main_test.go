package main

import "testing"

func TestFixedPositionsAndBends(t *testing.T) {
	diagram, err := compileSource(`vars: { d2-config: { layout-engine: tala; data: { tala-seeds: [1] } } }
 direction: right
 n0: "" { width: 210; height: 118; left: 100; top: 100 }
 n1: "" { width: 210; height: 118; left: 600; top: 450 }
 n0 -> n1: ""`)
	if err != nil {
		t.Fatal(err)
	}
	if len(diagram.Shapes) != 2 || len(diagram.Connections) != 1 {
		t.Fatal("incomplete diagram")
	}
	if diagram.Shapes[0].Pos.X != 100 || diagram.Shapes[0].Pos.Y != 100 || diagram.Shapes[1].Pos.X != 600 || diagram.Shapes[1].Pos.Y != 450 {
		t.Fatal("box positions changed")
	}
	if len(diagram.Connections[0].Route) < 3 {
		t.Fatal("connection has no bends")
	}
}

func TestInvalidInputReturnsError(t *testing.T) {
	if _, err := compileSource("a: {"); err == nil {
		t.Fatal("invalid diagram accepted")
	}
}
