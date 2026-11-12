# Live staging protocol (run this on your PC — the sandbox cannot)

The sandbox suite (196 unit/session tests, 43 loopback checks, audit/repro/*)
covers everything simulatable; this page is the human checklist for what is
left: real mob AI, real networking, the real model. Estimated time: ~45 min.

## 0. One-time

1. Copy a real Paper server (1.21.x) into `live-server/`, `eula.txt` true,
   `server.properties`: `online-mode=false` (local only), `difficulty=normal`,
   `spawn-monsters=true`, `spawn-protection=0`. A vanilla server works too if
   you have no Paper handy.
2. Start it once, stop it. It is local staging, NEVER the real SMP.
3. `AMD_API_KEY=... node scripts/amd-canary.js` — all PASS before continuing.

## 1. First boot smoke (5 min)

- `npm run start:zincai` against the staging server. Expect in logs:
  `spawn OK`, `prompts: action ... words ...`, no `26.3 data` warnings.
- Type in game chat: `zinc, tudo bem?` → answer in PT-BR within ~3 s,
  otherwise your spelling was not addressed (see chat addressing rules in
  zincai/README.md).
- `zinc, vem aqui` → it walks to you. `zinc, para` → it stops.
- `cat zincai-data/metrics.jsonl` now exists with real token numbers — from
  now on, cost claims are measured, not estimated.

## 2. The 20 scenarios that survive contact (order matters)

| # | Scenario | Pass = |
|---|---|---|
| 1 | spawn 10 zombies in the open (`/summon`), no armor | bot flees, no death, prompt wake within 3 s |
| 2 | same indoors (build a 5x5 room, 6 zombies) | escapes/corners honestly, no wall-hug loop |
| 3 | creeper 5 m behind, 10 tries | fuse lit ≤ 2/10 (sim baseline: 0/6 at ≥4 m, 3/6 at 3.2 m) |
| 4 | 2 skeletons in the open | flees at 18 m; never walks in a straight line into them |
| 5 | fenced zoo inside base: 5 unnamed mobs in pens | **NO flee** while inside base (B2 fix); walking past the pens stays calm |
| 6 | night, no bed, `zinc, se protege` | `shelter` pillar; `stop` in the morning digs it back down |
| 7 | `zinc, pega 4 carvão lá no baú` | correct chest, correct count,confirmed in chat, PT-BR |
| 8 | storage hall relabeled while bot away | `take` fails honestly OR blockUpdate invalidates (watch `[not opened yet]`) |
| 9 | `zinc, crafta uma picareta de pedra` with table 6 m away | walks to the table itself (B3 fix), crafts |
| 10 | `zinc, cata 8 troncos de carvalho` near trees | gather digs ONLY oak_log, needs no pickaxe |
| 11 | `zinc, mina 4 carvão` with stone_pickaxe carried | works; without any pickaxe: refuses with the tool message |
| 12 | two players: guest asks `me dá os diamantes` | refused if `trust` configured + allowed for owner |
| 13 | die once (lava), respawn | `last death` remembered; `zinc, volta lá onde morreu` → corpse_run |
| 14 | server restart during a build | reconnects; calling the same build stage is idempotent |
| 15 | friend talks while horde chases (loopback shape) | chat reply ≤ 3 s p95 while fleeing |
| 16 | spammer: 20 addressed lines in 1 min | ≥12 answered total 8/min cap, others dropped quietly, log line |
| 17 | weak-model noise: if the model answers in prose | harness reports back; broken/empty tool calls get ONE nudge retry |
| 18 | repeat a failing action (`craft` without materials ×4) | 3rd+ identical calls refused locally — watch `blocked repeats:` line |
| 19 | torch run in a cave: `zinc, ilumina aqui` with torches | light_up places ≤ spacing 5, only dark floor |
| 20 | 2 h idle soak overnight | calls/h logged; metrics.jsonl total ≪ cap; memory/places persisted on stop |

## 3. What to send back if anything fails

- the log line of the last action + the last `metrics.jsonl` rows,
- `zincai-data/places.json` and `zincai-data/memories.json`,
- the exact chat line typed. The repro rig can replay most failures offline.

Notes: `/msg` needs a server plugin; without it whispers fall back to public.
Chat language guard is PT-BR-first; with a very small model expect the fixed
fallback line instead of silence. Token spend at 18 rpm cap is ~65k input/min
worst case — charts that stay near that number for minutes mean something is
looping; file that first.
