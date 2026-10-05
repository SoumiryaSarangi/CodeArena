package main

import "testing"

func TestHello(t *testing.T) {
	if Hello() != "codearena-worker" {
		t.Fatal("unexpected")
	}
}
