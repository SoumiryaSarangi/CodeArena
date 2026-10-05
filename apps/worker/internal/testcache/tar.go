package testcache

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strconv"
)

// Limits that keep a hostile or corrupt testset from filling the disk.
const (
	MaxTarBytes     = 1 << 30
	MaxFileBytes    = 128 << 20
	MaxExtractBytes = 1 << 30
	MaxTests        = 2000
)

// ErrBadTestset means the archive is not a well-formed testset.
var ErrBadTestset = errors.New("testcache: bad testset")

// Entries are flat files named NN.in / NN.ans (2 to 4 digits). Anything else,
// including directories, links, absolute paths and "..", is rejected.
var entryName = regexp.MustCompile(`^([0-9]{2,4})\.(in|ans)$`)

// Case is one test: its number and the NN part of its file names.
type Case struct {
	No   int
	base string
}

// extract unpacks a verified tar into dir (which must be new and empty) and
// returns the cases sorted by number. Files are created O_EXCL with mode 0440.
func extract(r io.Reader, dir string) ([]Case, error) {
	tr := tar.NewReader(r)
	seen := map[string]bool{}
	var total int64
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadTestset, err)
		}
		if h.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("%w: %q is not a regular file", ErrBadTestset, h.Name)
		}
		if !entryName.MatchString(h.Name) {
			return nil, fmt.Errorf("%w: unexpected entry %q", ErrBadTestset, h.Name)
		}
		if seen[h.Name] {
			return nil, fmt.Errorf("%w: duplicate entry %q", ErrBadTestset, h.Name)
		}
		seen[h.Name] = true
		if len(seen) > 2*MaxTests {
			return nil, fmt.Errorf("%w: more than %d tests", ErrBadTestset, MaxTests)
		}
		if h.Size < 0 || h.Size > MaxFileBytes {
			return nil, fmt.Errorf("%w: %q is larger than %d MB", ErrBadTestset, h.Name, MaxFileBytes>>20)
		}
		if total += h.Size; total > MaxExtractBytes {
			return nil, fmt.Errorf("%w: contents are larger than %d MB", ErrBadTestset, MaxExtractBytes>>20)
		}
		if err := writeEntry(dir, h.Name, tr, h.Size); err != nil {
			return nil, err
		}
	}
	return pairs(seen)
}

func writeEntry(dir, name string, r io.Reader, size int64) error {
	f, err := os.OpenFile(dir+"/"+name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o440)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(r, size))
	if err == nil && n != size {
		err = fmt.Errorf("%w: %q is truncated", ErrBadTestset, name)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// pairs checks every .in has its .ans and returns the cases in order.
func pairs(seen map[string]bool) ([]Case, error) {
	var cases []Case
	nos := map[int]bool{}
	for name := range seen {
		m := entryName.FindStringSubmatch(name)
		if m[2] != "in" {
			continue
		}
		if !seen[m[1]+".ans"] {
			return nil, fmt.Errorf("%w: %s has no matching .ans", ErrBadTestset, name)
		}
		n, _ := strconv.Atoi(m[1])
		if nos[n] {
			return nil, fmt.Errorf("%w: test %d appears under two names", ErrBadTestset, n)
		}
		nos[n] = true
		cases = append(cases, Case{No: n, base: m[1]})
	}
	if len(cases) == 0 {
		return nil, fmt.Errorf("%w: no tests", ErrBadTestset)
	}
	if len(seen) != 2*len(cases) {
		return nil, fmt.Errorf("%w: an .ans has no matching .in", ErrBadTestset)
	}
	sort.Slice(cases, func(i, j int) bool { return cases[i].No < cases[j].No })
	return cases, nil
}
