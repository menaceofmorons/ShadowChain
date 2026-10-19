package scenario

import (
	"encoding/json"
	"fmt"
	"io"
)

func (r Result) WriteText(w io.Writer) error {
	if err := r.Report.WriteText(w); err != nil {
		return err
	}
	c := r.Counts
	_, err := fmt.Fprintf(w, "\nSeed: %d\nWindows: %d (burst %d)\nCommands: pastes=%d pasteLines=%d jumps=%d patches=%d snapshots=%d skipped=%d busy=%d otherErrors=%d maintenanceFailures=%d busyCheckpoints=%d\nSamples: queueWait=%d writeLatency=%d snapshot=%d\n",
		r.Seed, r.Windows, r.BurstWindows, c.Pastes, c.PasteLines, c.Jumps, c.Patches, c.Snapshots, c.Skipped, c.Busy, c.OtherErrors, c.MaintenanceFailures, c.BusyCheckpoints,
		c.QueueWaitSamples, c.WriteLatencySamples, c.SnapshotSamples)
	if err != nil {
		return err
	}
	if r.FirstError != "" {
		_, err = fmt.Fprintf(w, "First error: %s\n", r.FirstError)
	}
	return err
}

func (r Result) WriteJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}
