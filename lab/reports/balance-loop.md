# Balance loop (wave 3)

One line per experiment: hypothesis → change → `pnpm lab` (14 days × 3 tiers × 7 aircraft × 8 pilots) → kept or reverted.
Criteria line: speed/eco = best weather-aware ahead of best naive on moderate+extreme (share, median gain), calm share; smooth-ext; direct fuel left median; reckless dry on extreme; arrivals with >60 % fuel; surfer weather utilization p50; per-board top aircraft share; surfer unlock flights; direct minutes p50; failures.

| # | hypothesis / change | result | verdict |
|---|---|---|---|
| 0 | baseline (main merged) | speed 31% −0.8% calm 65% · eco 69% +6.6% · smooth-ext 100% +103% · fuel 57% dry 0 >60 46% · wu 3.1 · smooth widebody 100%, speed experimental 100%, eco experimental 74% · unlock 0/2/4/7/10/14/20 · min 9.6 · fail 7 | baseline |
| 1 | jets unreachable → add a low jet (core 6–7.5 km, ×1.3 speed), keep the high one | speed 23% −1.3% calm 49% · eco 51% +0.6% · wu 4.9 | kept as a base: no gain alone. Trace: climbing 2.4 → 6 km at full power takes 450 s of a 540 s flight, the jet is reached with 90 s to go |
| 2 | naive altitude gets a free westerly too → background westerly profile −10 m/s at the surface → 33 aloft (headwind below ~3.5 km); low jet ×1.6 | speed 30% −1.2% calm 52% · eco 73% +7.1% · fuel 55% · wu 4.5 | kept (small eco gain, sets up the vertical contrast); speed unchanged: the climb is still the bottleneck |
| 3 | make the jet a lateral decision instead of a vertical one: low jet at 4–5.5 km (the band the routes already fly), axis 9–13 km beside the straight line, little meander (≤2.5 km), half-width 4.5–6.5 km | speed 32% −0.6% · eco 75% +6.8% · wu 2.0 | kept, but no gain: the surfer's planner only considered the jet closest to the line (the high one) |
| 4 | bot fix, not a tuning: planner evaluates every jet within reach (one option per jet, sideways detour charged in time and fuel) and steers to the chosen core while climbing | speed 87% +10.0% calm 92% +10.2% · eco 87% +20.9% calm 96% · smooth-ext 98% +104% · fuel 55% dry 0 >60 45% · wu 7.3 · smooth widebody 95%, speed experimental 100%, eco experimental 90% · fail 24 (supersonic gate misses) | kept: a) met |
