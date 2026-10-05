package sandbox

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestReadFile(t *testing.T) {
	t.Run("FR-JUDGE-08: reads a regular file", func(t *testing.T) {
		dir := t.TempDir()
		write(t, filepath.Join(dir, "out.txt"), "42\n")
		got, trunc, err := ReadFile(dir, "out.txt", 1024)
		if err != nil || trunc || string(got) != "42\n" {
			t.Fatalf("got %q %v %v", got, trunc, err)
		}
	})

	t.Run("FR-JUDGE-08: caps the read and reports truncation", func(t *testing.T) {
		dir := t.TempDir()
		write(t, filepath.Join(dir, "out.txt"), "0123456789")
		got, trunc, err := ReadFile(dir, "out.txt", 4)
		if err != nil || !trunc || string(got) != "0123" {
			t.Fatalf("got %q %v %v", got, trunc, err)
		}
		got, trunc, err = ReadFile(dir, "out.txt", 10)
		if err != nil || trunc || len(got) != 10 {
			t.Fatalf("exact size: got %q %v %v", got, trunc, err)
		}
	})

	t.Run("FR-JUDGE-08: refuses a symlink to a host file", func(t *testing.T) {
		dir := t.TempDir()
		secret := filepath.Join(t.TempDir(), "secret")
		write(t, secret, "top secret")
		must(t, os.Symlink(secret, filepath.Join(dir, "out.txt")))
		assertUnsafe(t, dir, "out.txt")
	})

	t.Run("FR-JUDGE-08: refuses when the box dir itself is a symlink", func(t *testing.T) {
		real := t.TempDir()
		write(t, filepath.Join(real, "out.txt"), "x")
		link := filepath.Join(t.TempDir(), "box")
		must(t, os.Symlink(real, link))
		if _, _, err := ReadFile(link, "out.txt", 10); !errors.Is(err, syscall.ELOOP) && !errors.Is(err, syscall.ENOTDIR) {
			t.Fatalf("want ELOOP/ENOTDIR, got %v", err)
		}
	})

	t.Run("FR-JUDGE-08: refuses a FIFO without blocking", func(t *testing.T) {
		dir := t.TempDir()
		must(t, syscall.Mkfifo(filepath.Join(dir, "out.txt"), 0o644))
		done := make(chan error, 1)
		go func() { _, _, err := ReadFile(dir, "out.txt", 10); done <- err }()
		select {
		case err := <-done:
			if !errors.Is(err, ErrUnsafeFile) {
				t.Fatalf("want ErrUnsafeFile, got %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("ReadFile blocked on a FIFO")
		}
	})

	t.Run("FR-JUDGE-08: refuses a hard link", func(t *testing.T) {
		dir := t.TempDir()
		other := filepath.Join(dir, "other")
		write(t, other, "x")
		must(t, os.Link(other, filepath.Join(dir, "out.txt")))
		assertUnsafe(t, dir, "out.txt")
	})

	t.Run("FR-JUDGE-08: refuses a directory", func(t *testing.T) {
		dir := t.TempDir()
		must(t, os.Mkdir(filepath.Join(dir, "out.txt"), 0o755))
		assertUnsafe(t, dir, "out.txt")
	})

	t.Run("FR-JUDGE-08: refuses names that are not one component", func(t *testing.T) {
		dir := t.TempDir()
		for _, n := range []string{"", ".", "..", "a/b", "../etc/passwd", "/etc/passwd", "a\x00b"} {
			assertUnsafe(t, dir, n)
		}
	})

	t.Run("missing file is a plain not-exist error", func(t *testing.T) {
		if _, _, err := ReadFile(t.TempDir(), "nope", 10); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestWriteFileExcl(t *testing.T) {
	t.Run("FR-JUDGE-08: creates a new file with the exact mode", func(t *testing.T) {
		dir := t.TempDir()
		old := syscall.Umask(0o077)
		defer syscall.Umask(old)
		must(t, WriteFileExcl(dir, "main", []byte("bin"), 0o755))
		st, err := os.Lstat(filepath.Join(dir, "main"))
		must(t, err)
		if st.Mode().Perm() != 0o755 || !st.Mode().IsRegular() {
			t.Fatalf("mode %v", st.Mode())
		}
		got, _ := os.ReadFile(filepath.Join(dir, "main"))
		if !bytes.Equal(got, []byte("bin")) {
			t.Fatalf("content %q", got)
		}
	})

	t.Run("FR-JUDGE-08: refuses an existing file", func(t *testing.T) {
		dir := t.TempDir()
		write(t, filepath.Join(dir, "in.txt"), "old")
		if err := WriteFileExcl(dir, "in.txt", []byte("new"), 0o644); !errors.Is(err, os.ErrExist) {
			t.Fatalf("want ErrExist, got %v", err)
		}
	})

	t.Run("FR-JUDGE-08: never writes through a symlink", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(t.TempDir(), "target")
		must(t, os.Symlink(target, filepath.Join(dir, "in.txt")))
		if err := WriteFileExcl(dir, "in.txt", []byte("x"), 0o644); err == nil {
			t.Fatal("wrote through a symlink")
		}
		if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("symlink target was created: %v", err)
		}
	})

	t.Run("FR-JUDGE-08: refuses bad names", func(t *testing.T) {
		for _, n := range []string{"", "..", "a/b"} {
			if err := WriteFileExcl(t.TempDir(), n, nil, 0o644); !errors.Is(err, ErrUnsafeFile) {
				t.Fatalf("%q: got %v", n, err)
			}
		}
	})
}

func assertUnsafe(t *testing.T, dir, name string) {
	t.Helper()
	if _, _, err := ReadFile(dir, name, 10); !errors.Is(err, ErrUnsafeFile) {
		t.Fatalf("%q: want ErrUnsafeFile, got %v", name, err)
	}
}

func write(t *testing.T, path, s string) {
	t.Helper()
	must(t, os.WriteFile(path, []byte(s), 0o644))
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
