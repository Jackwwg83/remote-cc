/**
 * AskUserQuestion card — interactive option picking + submit → onAnswer.
 *
 * Indirectly tests the exported MessageRenderer since AskUserQuestionCard
 * isn't exported from the module.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import MessageRenderer, { type ChatMessage } from '../MessageRenderer'

afterEach(() => { cleanup() })

function makeAssistantMsg(questions: unknown): ChatMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'use-1',
          name: 'AskUserQuestion',
          input: { questions },
        },
      ],
    },
  }
}

describe('AskUserQuestion interactive card', () => {
  it('renders buttons for each option and they are clickable when onAnswer provided', () => {
    const onAnswer = vi.fn()
    const msg = makeAssistantMsg([
      { question: 'Pick one', options: [{ label: 'Apple' }, { label: 'Banana' }] },
    ])
    render(<MessageRenderer msg={msg} onAnswerQuestion={onAnswer} />)
    const apple = screen.getByRole('button', { name: 'Apple' }) as HTMLButtonElement
    expect(apple.disabled).toBe(false)
    fireEvent.click(apple)
    // Pressed state
    expect(apple.getAttribute('aria-pressed')).toBe('true')
  })

  it('Submit is disabled until every question is answered', () => {
    const onAnswer = vi.fn()
    const msg = makeAssistantMsg([
      { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Q2', options: [{ label: 'X' }, { label: 'Y' }] },
    ])
    render(<MessageRenderer msg={msg} onAnswerQuestion={onAnswer} />)
    const submit = screen.getByRole('button', { name: /Submit/i }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'X' }))
    expect(submit.disabled).toBe(false)
  })

  it('clicking Submit fires onAnswer with the tool_use_id AND selected labels', () => {
    const onAnswer = vi.fn()
    const msg = makeAssistantMsg([
      { question: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    ])
    render(<MessageRenderer msg={msg} onAnswerQuestion={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }))
    // Callback signature: (toolUseId, answers[])
    expect(onAnswer).toHaveBeenCalledWith(
      'use-1',
      [{ question: 'Color?', answer: 'Blue' }],
    )
  })

  it('second Submit click does nothing (locked after first submission)', () => {
    const onAnswer = vi.fn()
    const msg = makeAssistantMsg([
      { question: 'Pick', options: [{ label: 'A' }] },
    ])
    render(<MessageRenderer msg={msg} onAnswerQuestion={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    const submit = screen.getByRole('button', { name: /Submit/i }) as HTMLButtonElement
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledTimes(1)
    // After submit, button shows "Answered" + is disabled
    expect(screen.getByRole('button', { name: /Answered/i })).toBeTruthy()
  })

  it('without onAnswer, buttons are rendered but disabled (read-only preview)', () => {
    const msg = makeAssistantMsg([
      { question: 'Q', options: [{ label: 'Opt' }] },
    ])
    render(<MessageRenderer msg={msg} />)
    const opt = screen.getByRole('button', { name: 'Opt' }) as HTMLButtonElement
    expect(opt.disabled).toBe(true)
    // No Submit button when onAnswer is absent
    expect(screen.queryByRole('button', { name: /Submit/i })).toBeNull()
  })
})
