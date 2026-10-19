package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const (
	SyncNormal = "normal"
	SyncFull   = "full"

	MinReadPool     = 4
	MaxReadPool     = 8
	DefaultReadPool = 4

	BusyTimeoutMillis = 5000
	WALAutocheckpoint = 1000
)

type Options struct {
	Sync         string
	ReadPoolSize int
}

type DB struct {
	path   string
	writer *sql.DB
	reader *sql.DB
}

func SyncFromEnv() string {
	return os.Getenv("SC_DB_SYNC")
}

func Open(ctx context.Context, path string, opts Options) (*DB, error) {
	sync, err := normaliseSync(opts.Sync)
	if err != nil {
		return nil, err
	}
	readers := opts.ReadPoolSize
	if readers == 0 {
		readers = DefaultReadPool
	}
	if readers < MinReadPool || readers > MaxReadPool {
		return nil, fmt.Errorf("sqlite: read pool size %d outside %d-%d", readers, MinReadPool, MaxReadPool)
	}

	writer, err := openPool(ctx, path, sync, false)
	if err != nil {
		return nil, err
	}
	writer.SetMaxOpenConns(1)
	writer.SetMaxIdleConns(1)
	if err := writer.PingContext(ctx); err != nil {
		return nil, errors.Join(fmt.Errorf("sqlite: open write connection: %w", err), writer.Close())
	}

	reader, err := openPool(ctx, path, sync, true)
	if err != nil {
		return nil, errors.Join(err, writer.Close())
	}
	reader.SetMaxOpenConns(readers)
	reader.SetMaxIdleConns(readers)
	if err := reader.PingContext(ctx); err != nil {
		return nil, errors.Join(fmt.Errorf("sqlite: open read pool: %w", err), writer.Close(), reader.Close())
	}

	return &DB{path: path, writer: writer, reader: reader}, nil
}

func (d *DB) Writer() *sql.DB { return d.writer }

func (d *DB) Reader() *sql.DB { return d.reader }

func (d *DB) Path() string { return d.path }

func (d *DB) Close() error {
	return errors.Join(d.reader.Close(), d.writer.Close())
}

func normaliseSync(value string) (string, error) {
	switch v := strings.ToLower(strings.TrimSpace(value)); v {
	case "":
		return SyncNormal, nil
	case SyncNormal, SyncFull:
		return v, nil
	default:
		return "", fmt.Errorf("sqlite: SC_DB_SYNC %q must be %q or %q", value, SyncNormal, SyncFull)
	}
}

func openPool(_ context.Context, path, sync string, readOnly bool) (*sql.DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("sqlite: resolve path: %w", err)
	}
	pragmas := []string{
		"journal_mode(WAL)",
		"synchronous(" + sync + ")",
		"foreign_keys(ON)",
		fmt.Sprintf("busy_timeout(%d)", BusyTimeoutMillis),
		fmt.Sprintf("wal_autocheckpoint(%d)", WALAutocheckpoint),
	}
	if readOnly {
		pragmas = append(pragmas, "query_only(ON)")
	}
	query := url.Values{}
	for _, p := range pragmas {
		query.Add("_pragma", p)
	}
	dsn := (&url.URL{Scheme: "file", Opaque: filepath.ToSlash(abs), RawQuery: query.Encode()}).String()
	pool, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open %s: %w", path, err)
	}
	return pool, nil
}
