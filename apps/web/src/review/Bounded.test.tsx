import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Clipped } from './Bounded';
import { visible } from './review';

describe('Clipped', () => {
  it('shows control and format characters as escapes, keeping tabs and line breaks', () => {
    expect(visible('a\u202eb\u200bc\u0000d\re')).toBe('a\\u{202e}b\\u{200b}c\\u{0000}d\\u{000d}e');
    expect(visible('line 1\n\tline 2')).toBe('line 1\n\tline 2');
    // A lone surrogate, and an astral format character (a tag), as one escape each.
    expect(visible('x\ud800y\u{e0041}z')).toBe('x\\u{d800}y\\u{e0041}z');
    // Ordinary text, accents and emoji are left alone.
    expect(visible('Fräse 😀')).toBe('Fräse 😀');
  });

  it('renders an agent’s name with a bidi override as visible, isolated text', () => {
    const { container } = render(
      <p>
        Made by <Clipped value={'Good agent\u202e tnega liveE'} max={80} testId="name" />.
      </p>,
    );
    const name = screen.getByTestId('name');
    expect(name.textContent).toBe('Good agent\\u{202e} tnega liveE');
    expect(name.textContent).not.toContain('\u202e');
    // Isolated: whatever direction it has stays inside.
    expect(name.querySelector('bdi')).not.toBeNull();
    expect(container.textContent).toBe('Made by Good agent\\u{202e} tnega liveE.');
  });

  it('cuts first and escapes what is shown, and Show all escapes the rest too', () => {
    const value = `${'a'.repeat(5)}\u200b${'b'.repeat(10)}\u2066`;
    render(<Clipped value={value} max={8} testId="cut" />);
    const cut = screen.getByTestId('cut');
    expect(cut.textContent).toContain('aaaaa\\u{200b}bb...');
    fireEvent.click(screen.getByText('Show all'));
    expect(cut.textContent).toBe(`aaaaa\\u{200b}${'b'.repeat(10)}\\u{2066}`);
  });

  it('keeps the lines of code', () => {
    render(<Clipped value={'one\n\ttwo\u202e'} pre testId="code" />);
    const pre = screen.getByTestId('code').querySelector('pre')!;
    expect(pre.textContent).toBe('one\n\ttwo\\u{202e}');
  });
});
