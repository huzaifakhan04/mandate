/**
 * Where owner routes send a browser back to (P2 Task 5): the dashboard
 * with the agent's drawer open (`/dashboard?agent=<id>`), plus any notice
 * query (`mandate=signed`, `document_error=too_large`, …). `#agent-drawer`
 * scrolls a narrow screen down to the drawer, which stacks below the cards.
 */
export function agentDashboardPath(agentId: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ agent: agentId, ...query });
  return `/dashboard?${params.toString()}#agent-drawer`;
}
