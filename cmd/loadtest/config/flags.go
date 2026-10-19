package config

import (
	"flag"
	"strings"
)

type SetFlag []string

func (s *SetFlag) String() string { return strings.Join(*s, ",") }

func (s *SetFlag) Set(v string) error {
	*s = append(*s, v)
	return nil
}

type Flags struct {
	Path string
	Sets SetFlag
}

func RegisterFlags(fs *flag.FlagSet, defaultPath string) *Flags {
	f := &Flags{}
	fs.StringVar(&f.Path, "config", defaultPath, "path to the contention config file")
	fs.Var(&f.Sets, "set", "override a config value, section.key=value (repeatable)")
	return f
}

func (f *Flags) Load() (Config, error) { return Load(f.Path, f.Sets) }
