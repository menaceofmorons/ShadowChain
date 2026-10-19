package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const SupportedVersion = 1

type Thresholds struct {
	WriterQueueWaitP99Ms float64 `json:"writerQueueWaitP99Ms"`
	WriterQueueWaitMaxMs float64 `json:"writerQueueWaitMaxMs"`
	WriteLatencyP95Ms    float64 `json:"writeLatencyP95Ms"`
	SnapshotP95Ms        float64 `json:"snapshotP95Ms"`
	WALPeakMB            float64 `json:"walPeakMB"`
	WALPostCheckpointMB  float64 `json:"walPostCheckpointMB"`
	BusyErrors           int64   `json:"busyErrors"`
}

type Profile struct {
	Tenants          int     `json:"tenants"`
	Characters       int     `json:"characters"`
	DurationMinutes  float64 `json:"durationMinutes"`
	BurstShare       float64 `json:"burstShare"`
	PasteSizeMin     int     `json:"pasteSizeMin"`
	PasteSizeMax     int     `json:"pasteSizeMax"`
	RarePasteSizeMin int     `json:"rarePasteSizeMin"`
	RarePasteSizeMax int     `json:"rarePasteSizeMax"`
	RarePasteShare   float64 `json:"rarePasteShare"`
	Seed             uint64  `json:"seed"`

	WindowMillis       int     `json:"windowMillis"`
	BurstEveryWindows  int     `json:"burstEveryWindows"`
	BackgroundOpChance float64 `json:"backgroundOpChance"`
	JumpShare          float64 `json:"jumpShare"`
	SnapshotsPerSecond float64 `json:"snapshotsPerSecond"`
}

type Config struct {
	Version    int        `json:"version"`
	Thresholds Thresholds `json:"thresholds"`
	Profile    Profile    `json:"profile"`
}

func Load(path string, overrides []string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("config: read %s: %w", path, err)
	}
	cfg, err := parseUnvalidated(data)
	if err != nil {
		return Config{}, fmt.Errorf("config: %s: %w", path, err)
	}
	for _, o := range overrides {
		if err := cfg.Set(o); err != nil {
			return Config{}, err
		}
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, fmt.Errorf("config: %s: %w", path, err)
	}
	return cfg, nil
}

func Parse(data []byte) (Config, error) {
	cfg, err := parseUnvalidated(data)
	if err != nil {
		return Config{}, err
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func parseUnvalidated(data []byte) (Config, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return Config{}, err
	}
	if err := checkStruct("", reflect.TypeOf(Config{}), top); err != nil {
		return Config{}, err
	}
	var cfg Config
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func checkStruct(prefix string, t reflect.Type, got map[string]json.RawMessage) error {
	want := map[string]reflect.Type{}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		want[f.Tag.Get("json")] = f.Type
	}
	var unknown, missing []string
	for k := range got {
		if _, ok := want[k]; !ok {
			unknown = append(unknown, prefix+k)
		}
	}
	for k := range want {
		if _, ok := got[k]; !ok {
			missing = append(missing, prefix+k)
		}
	}
	sort.Strings(unknown)
	sort.Strings(missing)
	if len(unknown) > 0 {
		return fmt.Errorf("unknown key(s): %s", strings.Join(unknown, ", "))
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing key(s): %s", strings.Join(missing, ", "))
	}
	for k, ft := range want {
		if ft.Kind() != reflect.Struct {
			continue
		}
		var sub map[string]json.RawMessage
		if err := json.Unmarshal(got[k], &sub); err != nil {
			return fmt.Errorf("%s%s: %w", prefix, k, err)
		}
		if err := checkStruct(prefix+k+".", ft, sub); err != nil {
			return err
		}
	}
	return nil
}

func (c *Config) Set(kv string) error {
	key, value, ok := strings.Cut(kv, "=")
	if !ok || key == "" {
		return fmt.Errorf("config: override %q must be key=value", kv)
	}
	section, name, ok := strings.Cut(key, ".")
	if !ok {
		return fmt.Errorf("config: override key %q must be section.name", key)
	}
	var target reflect.Value
	switch section {
	case "thresholds":
		target = reflect.ValueOf(&c.Thresholds).Elem()
	case "profile":
		target = reflect.ValueOf(&c.Profile).Elem()
	default:
		return fmt.Errorf("config: unknown override key %q", key)
	}
	for i := 0; i < target.NumField(); i++ {
		if target.Type().Field(i).Tag.Get("json") == name {
			return setField(target.Field(i), key, value)
		}
	}
	return fmt.Errorf("config: unknown override key %q", key)
}

func setField(f reflect.Value, key, value string) error {
	switch f.Kind() {
	case reflect.Float64:
		v, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return fmt.Errorf("config: override %s: %w", key, err)
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Errorf("config: override %s: value must be finite", key)
		}
		f.SetFloat(v)
	case reflect.Int, reflect.Int64:
		v, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return fmt.Errorf("config: override %s: %w", key, err)
		}
		f.SetInt(v)
	case reflect.Uint64:
		v, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			return fmt.Errorf("config: override %s: %w", key, err)
		}
		f.SetUint(v)
	default:
		return fmt.Errorf("config: override %s: unsupported type", key)
	}
	return nil
}

func (c Config) Validate() error {
	var errs []error
	bad := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if c.Version != SupportedVersion {
		bad("version %d unsupported, want %d", c.Version, SupportedVersion)
	}
	t := c.Thresholds
	for name, v := range map[string]float64{
		"thresholds.writerQueueWaitP99Ms": t.WriterQueueWaitP99Ms,
		"thresholds.writerQueueWaitMaxMs": t.WriterQueueWaitMaxMs,
		"thresholds.writeLatencyP95Ms":    t.WriteLatencyP95Ms,
		"thresholds.snapshotP95Ms":        t.SnapshotP95Ms,
		"thresholds.walPeakMB":            t.WALPeakMB,
		"thresholds.walPostCheckpointMB":  t.WALPostCheckpointMB,
	} {
		if v < 0 {
			bad("%s must not be negative", name)
		}
	}
	if t.BusyErrors < 0 {
		bad("thresholds.busyErrors must not be negative")
	}
	p := c.Profile
	if p.Tenants <= 0 {
		bad("profile.tenants must be positive")
	}
	if p.Characters <= 0 {
		bad("profile.characters must be positive")
	}
	if p.DurationMinutes <= 0 {
		bad("profile.durationMinutes must be positive")
	}
	if p.BurstShare <= 0 || p.BurstShare > 1 {
		bad("profile.burstShare must be in (0, 1]")
	}
	if p.RarePasteShare < 0 || p.RarePasteShare > 1 {
		bad("profile.rarePasteShare must be in [0, 1]")
	}
	if p.WindowMillis <= 0 {
		bad("profile.windowMillis must be positive")
	}
	if p.BurstEveryWindows <= 0 {
		bad("profile.burstEveryWindows must be positive")
	}
	if p.BackgroundOpChance < 0 || p.BackgroundOpChance > 1 {
		bad("profile.backgroundOpChance must be in [0, 1]")
	}
	if p.JumpShare < 0 || p.JumpShare > 1 {
		bad("profile.jumpShare must be in [0, 1]")
	}
	if p.SnapshotsPerSecond <= 0 || math.IsNaN(p.SnapshotsPerSecond) || math.IsInf(p.SnapshotsPerSecond, 0) {
		bad("profile.snapshotsPerSecond must be positive and finite")
	}
	if p.PasteSizeMin <= 0 || p.PasteSizeMax < p.PasteSizeMin || p.PasteSizeMax > store.MaxPasteLines {
		bad("profile.pasteSizeMin/pasteSizeMax must satisfy 0 < min <= max <= %d", store.MaxPasteLines)
	}
	if p.RarePasteSizeMin <= 0 || p.RarePasteSizeMax < p.RarePasteSizeMin || p.RarePasteSizeMax > store.MaxPasteLines {
		bad("profile.rarePasteSizeMin/rarePasteSizeMax must satisfy 0 < min <= max <= %d", store.MaxPasteLines)
	}
	return errors.Join(errs...)
}
