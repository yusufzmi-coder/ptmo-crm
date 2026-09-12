import { describe, expect, it } from 'vitest'

import { safeNext } from './route'

// `next` comes off the query string of a URL anyone can send to a user,
// and it is used as a redirect target the moment the session cookies are
// written. An unvalidated value here is an open redirect that fires at
// the exact instant the visitor is newly authenticated, so each refusal
// below is the guard, not a nicety.
describe('safeNext', () => {
  it('falls back to the dashboard when absent', () => {
    expect(safeNext(null)).toBe('/dashboard')
    expect(safeNext('')).toBe('/dashboard')
  })

  it('keeps a same-origin path', () => {
    expect(safeNext('/reset-password')).toBe('/reset-password')
    expect(safeNext('/join/abc123')).toBe('/join/abc123')
    expect(safeNext('/inbox?c=1')).toBe('/inbox?c=1')
  })

  it('refuses an absolute URL on another origin', () => {
    expect(safeNext('https://evil.example')).toBe('/dashboard')
    expect(safeNext('http://evil.example/x')).toBe('/dashboard')
  })

  it('refuses a protocol-relative target', () => {
    // `//evil.example` is a valid URL meaning "same scheme, that host" —
    // it does start with a slash, which is why the leading-slash check
    // alone is not enough.
    expect(safeNext('//evil.example')).toBe('/dashboard')
    expect(safeNext('//evil.example/path')).toBe('/dashboard')
  })

  it('refuses a backslash-host target', () => {
    // Some browsers normalise `/\host` to `//host`.
    expect(safeNext('/\\evil.example')).toBe('/dashboard')
  })

  it('refuses a scheme without a leading slash', () => {
    expect(safeNext('javascript:alert(1)')).toBe('/dashboard')
    expect(safeNext('dashboard')).toBe('/dashboard')
  })
})
