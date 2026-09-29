/**
 * The keys every selectable list answers, in one place. Ten lists each
 * clamped an index on the arrows in their own way; this is the one way.
 * Returns the index to move to, or null when the key is not a movement:
 * the caller prevents the default and sets the index, and handles Enter
 * and Escape itself, since what those mean differs by list.
 */
export function navigateList(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  const last = count - 1
  switch (key) {
    case 'ArrowDown':
      return Math.min(index + 1, last)
    case 'ArrowUp':
      return Math.max(index - 1, 0)
    case 'Home':
      return 0
    case 'End':
      return last
    case 'PageDown':
      return Math.min(index + 10, last)
    case 'PageUp':
      return Math.max(index - 10, 0)
    default:
      return null
  }
}
