/**
 * ProgressIndicator — in-flight tool execution indicator.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ProgressIndicator from '../ProgressIndicator'

describe('ProgressIndicator', () => {
  it('renders "Running Bash" with seconds under a minute', () => {
    render(<ProgressIndicator toolName="Bash" elapsedSeconds={5} />)
    expect(screen.getByText(/Running Bash/i)).toBeTruthy()
    expect(screen.getByText('5s')).toBeTruthy()
  })

  it('renders minutes + seconds above 60s', () => {
    render(<ProgressIndicator toolName="Bash" elapsedSeconds={125} />)
    expect(screen.getByText('2m 5s')).toBeTruthy()
  })

  it('uses friendly "Running {tool}" label for non-Bash tools', () => {
    render(<ProgressIndicator toolName="WebFetch" elapsedSeconds={3} />)
    expect(screen.getByText(/Running WebFetch/i)).toBeTruthy()
  })

  it('has aria-live for screen readers', () => {
    const { container } = render(<ProgressIndicator toolName="Bash" elapsedSeconds={1} />)
    const root = container.firstChild as HTMLElement
    expect(root.getAttribute('role')).toBe('status')
    expect(root.getAttribute('aria-live')).toBe('polite')
  })
})
