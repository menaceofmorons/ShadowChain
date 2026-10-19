package store

import "errors"

const MaxPasteLines = 500

var (
	ErrPasteTooLarge   = errors.New("store: paste exceeds line cap")
	ErrNotFound        = errors.New("store: not found")
	ErrVersionConflict = errors.New("store: version conflict")
	ErrInvalidSigCode  = errors.New("store: invalid signature id")
)
