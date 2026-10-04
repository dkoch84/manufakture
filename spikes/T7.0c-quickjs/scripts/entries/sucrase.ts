// Bundle-size entry: what shipping sucrase's TypeScript transform costs.
import { transform } from 'sucrase';

export function erase(source: string): string {
  return transform(source, { transforms: ['typescript'], disableESTransforms: true }).code;
}
