package sandbox

import (
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"syscall"
)

// ErrUnsafeFile means a box file was a symlink, FIFO, device, directory or
// hard link, so it was not read or written.
var ErrUnsafeFile = errors.New("sandbox: unsafe file in box")

// checkName allows a single path component only.
func checkName(name string) error {
	switch {
	case name == "" || name == "." || name == "..":
		return fmt.Errorf("bad file name %q", name)
	case len(name) > 255 || strings.ContainsAny(name, "/\x00"):
		return fmt.Errorf("bad file name %q", name)
	}
	return nil
}

func openDir(dir string) (int, error) {
	fd, err := syscall.Open(dir, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return -1, &os.PathError{Op: "open", Path: dir, Err: err}
	}
	return fd, nil
}

// ReadFile reads dir/name without following anything the sandbox controls and
// returns at most limit bytes. truncated reports that the file was longer.
func ReadFile(dir, name string, limit int64) (data []byte, truncated bool, err error) {
	if limit < 0 {
		return nil, false, fmt.Errorf("sandbox: negative read limit")
	}
	if err := checkName(name); err != nil {
		return nil, false, fmt.Errorf("%w: %v", ErrUnsafeFile, err)
	}
	dfd, err := openDir(dir)
	if err != nil {
		return nil, false, err
	}
	defer syscall.Close(dfd)

	fd, err := syscall.Openat(dfd, name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		if err == syscall.ELOOP {
			return nil, false, fmt.Errorf("%w: %s is a symlink", ErrUnsafeFile, name)
		}
		return nil, false, &os.PathError{Op: "openat", Path: name, Err: err}
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()

	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return nil, false, &os.PathError{Op: "fstat", Path: name, Err: err}
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return nil, false, fmt.Errorf("%w: %s is not a regular file", ErrUnsafeFile, name)
	}
	if st.Nlink != 1 {
		return nil, false, fmt.Errorf("%w: %s has %d links", ErrUnsafeFile, name, st.Nlink)
	}

	data, err = io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, false, &os.PathError{Op: "read", Path: name, Err: err}
	}
	if int64(len(data)) > limit {
		return data[:limit], true, nil
	}
	return data, false, nil
}

// WriteFileExcl creates dir/name, which must not exist in any form, with
// exactly perm, and writes data to it.
func WriteFileExcl(dir, name string, data []byte, perm os.FileMode) error {
	if err := checkName(name); err != nil {
		return fmt.Errorf("%w: %v", ErrUnsafeFile, err)
	}
	dfd, err := openDir(dir)
	if err != nil {
		return err
	}
	defer syscall.Close(dfd)

	fd, err := syscall.Openat(dfd, name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, uint32(perm.Perm()))
	if err != nil {
		return &os.PathError{Op: "openat", Path: name, Err: err}
	}
	f := os.NewFile(uintptr(fd), name)
	// The umask may have cleared bits; set the mode we asked for.
	if err := f.Chmod(perm.Perm()); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// ListFiles returns the entry names in dir (any type; callers read each with
// ReadFile, which refuses anything that is not a plain file). Names that are
// not a single safe path component are skipped.
func ListFiles(dir string) ([]string, error) {
	dfd, err := openDir(dir)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(dfd), dir)
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, &os.PathError{Op: "readdir", Path: dir, Err: err}
	}
	out := names[:0]
	for _, n := range names {
		if checkName(n) == nil {
			out = append(out, n)
		}
	}
	slices.Sort(out)
	return out, nil
}
