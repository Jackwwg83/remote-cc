/** Extract the auth token from the page URL (?token=xxx) */
export function getAuthToken(): string | null {
  return new URLSearchParams(window.location.search).get('token')
}

/** Build headers with auth token for HTTP API requests */
export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}
