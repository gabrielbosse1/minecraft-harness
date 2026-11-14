# Probes behind TOOL_AUDIT.md

Standalone `node` scripts, run from the repo root, against the repo's own
synthetic world (`test/helpers/world.js`: real prismarine blocks, real
mineflayer-pathfinder, real physics). No server, no network.

    node .probe/p26.js     # build claim sampling: 21x21 floor, claim at centre -> not refused
    node .probe/p30.js     # dig corridor vs standing policy on a claimed wall (4 arms)
    node .probe/p31.js     # use_block substring matching ("bed" -> bedrock)
    node .probe/p34.js     # which index.js verbs consult a property guard

`/tmp/probe*.js` (from the first pass) cover: dig claim bypass (probe5),
mode:"all" breakability (probe8), hold args, recall scoring (probe14),
build_shape geometry, pets/PvP (probe11-12), dig_policy validation (probe16).
