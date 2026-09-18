//go:build !windows

package processutil

import "os/exec"

func configure(command *exec.Cmd) {
}
