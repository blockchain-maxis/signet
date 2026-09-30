package cmd

import "github.com/spf13/cobra"

// group is a heading in `signet --help`. Every command belongs to one.
type group struct {
	id    string
	title string
}

// The groups, in the order `signet --help` lists them. A group with no
// registered commands is left out of the help output rather than shown as an
// empty heading; Contracts is reserved for the sandbox (`signet dev`,
// `signet sandbox`) and visualiser (`signet visualise`) commands and appears the
// moment the first of them registers.
var (
	groupIdentity    = group{"identity", "Identity & linking:"}
	groupDeployments = group{"deployments", "Deployments:"}
	groupContracts   = group{"contracts", "Contracts:"}
	groupOther       = group{"other", "Other:"}
)

var groupOrder = []group{groupIdentity, groupDeployments, groupContracts, groupOther}

type registration struct {
	group group
	new   func() *cobra.Command
}

var registrations []registration

// register adds a command to the tree under a group. Each command file calls it
// from its own init, so adding a command is a one-file change:
//
//	func init() { register(groupContracts, newDevCmd) }
//
// The constructor takes no arguments: a command reads what it needs from Deps
// at run time (see depsFor), which is what lets a test build it on its own.
func register(g group, newCmd func() *cobra.Command) {
	registrations = append(registrations, registration{group: g, new: newCmd})
}

// addRegisteredCommands attaches every registered command to root, creating
// each group that has at least one command and pointing cobra's built-in help
// and completion commands at Other.
func addRegisteredCommands(root *cobra.Command) {
	used := map[string]bool{groupOther.id: true}
	for _, r := range registrations {
		used[r.group.id] = true
	}
	for _, g := range groupOrder {
		if used[g.id] {
			root.AddGroup(&cobra.Group{ID: g.id, Title: g.title})
		}
	}

	root.SetHelpCommandGroupID(groupOther.id)
	root.SetCompletionCommandGroupID(groupOther.id)

	for _, r := range registrations {
		c := r.new()
		c.GroupID = r.group.id
		root.AddCommand(c)
	}
}
