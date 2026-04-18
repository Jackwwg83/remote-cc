/** Extract the session auth token from the page URL (?token=xxx).
 *  Used for /sessions/*, /events/stream, /messages, /machine/info. */
export function getAuthToken(): string | null {
  return new URLSearchParams(window.location.search).get('token')
}

/** Extract the cluster token from the page URL (?cluster_token=xxx).
 *  Used for all /cluster/* endpoints. Returns null if not cluster mode. */
export function getClusterToken(): string | null {
  return new URLSearchParams(window.location.search).get('cluster_token')
}

/** Build headers with session auth token for HTTP API requests */
export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/** Build headers with cluster token for /cluster/* endpoints */
export function getClusterHeaders(): Record<string, string> {
  const token = getClusterToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}
