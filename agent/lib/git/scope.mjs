// Paths outside the implementation: Scaffold bookkeeping. A root entry named `.scaffold` or starting with
// `.scaffold` plus another character (`.scaffold.zip`, `.scaffold-backup/`) is reserved for it, so exports or
// backups of workflow state are never fingerprinted, reviewed or checkpointed as implementation changes.
export const RESERVED_EXCLUDES = [
  ":(exclude).scaffold",
  ":(exclude,glob).scaffold?*",
  ":(exclude,glob).scaffold?*/**",
];
export const IMPLEMENTATION_SCOPE = ["--", ".", ...RESERVED_EXCLUDES];
// Pathspec selecting only reserved paths (for bookkeeping visibility and tracked-file checks).
export const RESERVED_PATHS = [".scaffold", ":(glob).scaffold?*", ":(glob).scaffold?*/**"];
