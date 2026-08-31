// fakestellar stands in for the real `stellar` binary in ExecRunner's tests —
// it only understands `keys ls` and `keys public-key <name>`, matching the
// exact shapes ExecRunner needs to handle (stdout on success, a non-zero exit
// with stderr text on failure).
package main

import (
	"fmt"
	"os"
)

func main() {
	args := os.Args[1:]
	if len(args) == 2 && args[0] == "keys" && args[1] == "ls" {
		fmt.Println("alice")
		fmt.Println("bob")
		return
	}
	if len(args) == 3 && args[0] == "keys" && args[1] == "public-key" {
		switch args[2] {
		case "alice":
			fmt.Println("GA7YI536V4BC7CL43DRMZ2UU7N4T3VZZSY7FVOY6Q4JUPBVZYHN43QMT")
			return
		default:
			fmt.Fprintf(os.Stderr, "error: no identity called %q found\n", args[2])
			os.Exit(1)
		}
	}
	fmt.Fprintf(os.Stderr, "fakestellar: unrecognized args %v\n", args)
	os.Exit(2)
}
