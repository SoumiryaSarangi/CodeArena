package main

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// randHex returns a short random hex string for the env canary.
func randHex() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// noProcsForUIDs reports true when no live process runs as any of the given
// uids. A box's processes should all be gone once its slot is released; a
// survivor means the sandbox did not clean up (SD-§16.1 escape class).
func noProcsForUIDs(uids []int) bool {
	want := map[int]bool{}
	for _, u := range uids {
		want[u] = true
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return true // cannot read /proc: do not raise a false alarm
	}
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue // not a pid dir
		}
		data, err := os.ReadFile(filepath.Join("/proc", e.Name(), "status"))
		if err != nil {
			continue // the process exited between readdir and read
		}
		for _, line := range strings.Split(string(data), "\n") {
			if !strings.HasPrefix(line, "Uid:") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if uid, err := strconv.Atoi(fields[1]); err == nil && want[uid] {
					return false
				}
			}
			break
		}
	}
	return true
}

// parentAlive reports whether this process's parent is still alive. A program
// that managed to signal or kill the worker would orphan us (reparented to 1).
func parentAlive() bool {
	return syscall.Getppid() > 1
}
