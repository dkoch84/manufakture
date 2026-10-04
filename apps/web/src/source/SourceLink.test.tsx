import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SourceLink } from './SourceLink';

describe('SourceLink', () => {
  it('links to the source page under the base, in a new tab without an opener', () => {
    render(<SourceLink />);
    const link = screen.getByTestId('source-link');
    expect(link.textContent).toBe('Source');
    expect(link.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}source.html`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
