/**
 * POSIX shell quoting. Every value interpolated into a remote command MUST pass
 * through here so user input (paths, names, image tags) cannot break out of the
 * command or inject additional commands.
 */
export function shq(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  // Wrap in single quotes; a literal single quote becomes: '\''
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shqArgs(values: readonly string[]): string {
  return values.map(shq).join(" ");
}
