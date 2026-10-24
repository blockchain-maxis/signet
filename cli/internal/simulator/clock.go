package simulator

import "time"

// Clock schedules the idle stop. Tests inject one they can fire by hand.
type Clock interface {
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is the part of *time.Timer the client uses.
type Timer interface {
	Stop() bool
}

type realClock struct{}

func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }
