// Bundle-size entry: what shipping ts-blank-space costs.
import tsBlankSpace from 'ts-blank-space';

export function erase(source: string): string {
  return tsBlankSpace(source);
}
