# SuiPredict-AI 30-Sweep E2E Audit

Each sweep is a distinct area of the system. Goal: production-grade product.

## Sweep Categories

### UI/UX (15 sweeps)
1. Home page `/` — WC banner, hero, stats, featured markets, gamification, daily WC card, recent activity
2. World Cup dashboard `/worldcup` — Hero, live ticker, groups, schedule
3. World Cup group detail `/worldcup/group/[letter]` — Teams, matches, deep links
4. Markets list `/markets` — Search, filter, sort, status, error handling
5. Market detail `/markets/[id]` — Order book, mint, redeem, friends' positions, share, dispute
6. Friends `/friends` — Follow list, portfolio fetching, removal
7. Parlay `/parlay` — Builder, history, claim
8. Vault `/vault` — Deposit, withdraw, summary
9. Portfolio `/portfolio` — List of positions, view on SuiVision
10. Leaderboard `/leaderboard` — Weekly top-N, country filter, category filter
11. Admin `/admin` — Withdraw fees, distribution, resolve dispute, parlay admin
12. Settings `/settings` — Profile, agent policy
13. Agents `/agents` — Decision feed, manifest, drift detector
14. Dispute `/dispute/[marketId]` — Evidence submission
15. Auth callback `/auth` — Enoki zkLogin

### API/Backend (5 sweeps)
16. Agents REST API `/markets`, `/markets/:id`, `/markets/:id/book`, `/decisions`, `/stats`
17. WC endpoints `/wc/groups`, `/wc/schedule`, `/wc/upcoming`
18. Gamification `/prize`, `/streak`, `/leaderboard`, `/portfolio`
19. Parlay `/parlay/user/:addr`, `/parlay/:id`
20. Health `/health` payload completeness

### Cross-cutting (10 sweeps)
21. Mobile responsiveness — bottom nav, touch targets, viewport
22. Accessibility — aria-labels, focus management, color contrast
23. Loading/empty/error states
24. Navigation & links
25. Wallet integration — Connect flow, signAndExecute
26. Demo mode coverage
27. Data consistency (Agents REST vs web rendering)
28. Streak/leaderboard/prize flow
29. Performance & bundle size
30. Visual polish & branding consistency
