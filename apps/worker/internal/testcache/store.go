package testcache

import (
	"context"
	"fmt"
	"io"
	"net/url"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Store reads objects. The judge's object-store key is read-only (FR-JUDGE-09),
// so this interface has no write method.
type Store interface {
	// Open returns the object body and its size, or an error wrapping
	// ErrNotFound when the key does not exist.
	Open(ctx context.Context, bucket, key string) (io.ReadCloser, int64, error)
}

// S3Config configures the S3-compatible store (SeaweedFS in this project;
// minio-go speaks the S3 API).
type S3Config struct {
	Endpoint  string // http(s)://host:port
	AccessKey string
	SecretKey string
}

type s3Store struct{ c *minio.Client }

// NewS3 connects (lazily) to an S3-compatible endpoint with path-style access.
func NewS3(cfg S3Config) (Store, error) {
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("testcache: bad S3 endpoint %q", cfg.Endpoint)
	}
	c, err := minio.New(u.Host, &minio.Options{
		Creds:        credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:       u.Scheme == "https",
		BucketLookup: minio.BucketLookupPath,
	})
	if err != nil {
		return nil, err
	}
	return &s3Store{c}, nil
}

func (s *s3Store) Open(ctx context.Context, bucket, key string) (io.ReadCloser, int64, error) {
	obj, err := s.c.GetObject(ctx, bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, 0, err
	}
	// GetObject is lazy; Stat makes missing keys fail here.
	st, err := obj.Stat()
	if err != nil {
		_ = obj.Close()
		if minio.ToErrorResponse(err).Code == "NoSuchKey" {
			return nil, 0, fmt.Errorf("%w: %s/%s", ErrNotFound, bucket, key)
		}
		return nil, 0, err
	}
	return obj, st.Size, nil
}
