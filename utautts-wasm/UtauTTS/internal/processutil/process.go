package processutil

import "os/exec"

func Configure(command *exec.Cmd) {
	configure(command)
}
