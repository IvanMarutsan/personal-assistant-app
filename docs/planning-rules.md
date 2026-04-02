# Deterministic planning rules (V1)

Thresholds are centralized in:
- `supabase/functions/_shared/planning-config.ts`

This keeps magic numbers out of handlers and makes the rule layer inspectable.

Current rules version:
- `v1-deterministic`

`get-planning-assistant` uses:
1. Overdue planned tasks
2. Hard commitment tasks for today
3. Protected essentials still pending
4. High-importance planned today tasks
5. Quick communication batching suggestion

Overload and risk checks also read from the same threshold config.
