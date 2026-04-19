/**
 * CostFooter — compact token + cost + duration display.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CostFooter from '../CostFooter'

describe('CostFooter', () => {
  it('renders nothing when all fields are empty', () => {
    const { container } = render(<CostFooter />)
    expect(container.firstChild).toBeNull()
  })

  it('shows tokens, cost, duration in expected formats', () => {
    render(
      <CostFooter
        usage={{ input_tokens: 1234, output_tokens: 567 }}
        totalCostUsd={0.0215}
        durationMs={2500}
      />,
    )
    // 1234 → 1.2k, 567 → 567
    expect(screen.getByText(/1\.2k in/)).toBeTruthy()
    expect(screen.getByText(/567 out/)).toBeTruthy()
    expect(screen.getByText(/\$0\.0215/)).toBeTruthy()
    expect(screen.getByText(/2\.5s/)).toBeTruthy()
  })

  it('accepts both camelCase and snake_case usage fields', () => {
    render(<CostFooter usage={{ inputTokens: 500, outputTokens: 100 }} />)
    expect(screen.getByText(/500 in/)).toBeTruthy()
    expect(screen.getByText(/100 out/)).toBeTruthy()
  })

  it('shows cache tokens when present', () => {
    render(
      <CostFooter
        usage={{
          input_tokens: 100,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 500,
        }}
      />,
    )
    expect(screen.getByText(/2\.5k cache/)).toBeTruthy()
  })

  it('uses 5-decimal format for tiny costs', () => {
    render(<CostFooter usage={{ input_tokens: 10 }} totalCostUsd={0.00005} />)
    expect(screen.getByText('$0.00005')).toBeTruthy()
  })

  it('shows minutes+seconds for durations over 1 minute', () => {
    render(<CostFooter usage={{ input_tokens: 1 }} durationMs={125_000} />)
    expect(screen.getByText(/2m 5s/)).toBeTruthy()
  })
})
