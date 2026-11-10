# Vendored Minecraft Java 26.3 data

The pc/26.3 dataset (protocol version **777**) is **not published on npm** as of
`minecraft-data@3.119.0`. These 23 files are the exact generated output of the
official minecraft-data generator, taken from:

- Fork PR branch: `suisarbre/minecraft-data @ port-26.3`
- Head commit: `312f3cada17a7d9e2e1a1834fe26f17296163096`
- Upstream PR series: https://github.com/PrismarineJS/minecraft-data/pull/1300
  ("Add Minecraft pc 26.3 data"), stacked fixes #1301 and #1345
- Status at time of vendoring (2026-11-10): both PRs OPEN, `mergeable: clean`

## Files (SHA-256)

```
0d08bd2b5bce95b84405b8d39d259a365663789d22e968bdbdad9a2d4b2cc45f  version.json
10ccf11edbe4d5a2c6f29d18d52877ba5945066e8aecfaa10c1d3da1d56a46ce  items.json
2a9dbff4cd6d859868f6d08024c0c83193f24143da95e0071906e42b36ec1ffe  proto.yml
32451f6081ed01c85a57f4f56e2c3866c6b63ea8490b18550001b9432a3cbadb  materials.json
3b332fcfde93421a22ea751966f7b934800913cdcc509ea9d263dca19edf8ad9  tints.json
43544f04ce2c69a6c9431673041d7e05c0760987aa2119ccfca58fc1bb8a0b2d  enchantments.json
4a82929a47559d99cabdbbe397da33c332bfc29626284a1605b56fdb9f2a41ed  particles.json
4b9af382491bd06aedc5c9ad33ee5f3a57d47aa5b021e83292ab584efedc8e8c  effects.json
4f091ba455206e24d0b6073802169b155ba0cc95bc657fa00fba4d1d8791925c  language.json
98c9d7033e361e43f6c727d3e8f9f26f03c0b6dbbb575d15ee6dd340de3de08f  entityLoot.json
99c4dc244469c542247041552062d4ec40c83a1929b578d52c5e610c15773d86  recipes.json
9b7a08100999726b0aa874e0ee0b5ef3565a58945c852581ed01c6a53873f448  blocks.json
a17d5e5cc7aaa2fb34ba356b1d6e1150784c8d874fba7ee5a9847511bc60d699  commands.json
c2182c8a0c00fa9767fcf34fedac683de1aef7acd113f64a9b375586c1a38fba  protocol.json
c45e824b39c2d21d7f4bdab2195a1e05bc4a5a217a413efa837affcbcda32852  sounds.json
ccd2e17df0528fb9954c4f8fb1626fe9ff1d1c8e36b2484ab126179b10de5df2  attributes.json
d28a2896cc97628f07134247eebd3c6b234a42a834063a425daa61c1684d32fd  entities.json
d88805e850ea44bfa18aaecab184945cfe9cdd6a171ac595a688a2636f70c02d  biomes.json
e0cdb84c90abee01dfbfdd5227915b2e61bbb4c05025b39f7d0fb331f66ac4b8  loginPacket.json
f74153873a365af9b270144bbd49c6ff5164d049a52216aace270cafa2d20da0  blockLoot.json
f745825f467d804ae66592c4db99e51ab1f9b64a2f710b9d33524d3dd74b5824  instruments.json
f9eef56158a146c3d26e4f894509e6933fcfa029c6ecd0d19b6818be77a47b25  foods.json
fa0d1687e352aafb0a0827c901f25170b9424a189f127c322d7a36bfbeff41ca  blockCollisionShapes.json
```

Verify any time with: `cd vendor/minecraft-data-26.3/pc-26.3 && sha256sum -c`

## How it's applied

`npm install` / `npm ci` runs `scripts/apply-26.3-data.js`, which:

1. copies these files into `node_modules/minecraft-data/minecraft-data/data/pc/26.3/`
2. injects a lazily-loaded `'26.3'` entry into `node_modules/minecraft-data/data.js`
   (aliasing `windows` and `mapIcons` exactly as the published 26.1 entry does)
3. adds `pc['26.3']` to `dataPaths.json`
4. extends the `testedVersions` list in `mineflayer/lib/version.js` with `'26.3'`
   (mineflayer refuses to load for versions it has not declared)
5. extends the `supportedVersions` list in `minecraft-protocol/src/version.js`
   with `'26.3'`
6. maps `pc 26.3` to the modern `pc/1.18/chunk` implementation in
   `prismarine-chunk/src/index.js` (everything 1.18 → 26.1 maps there already)
7. clones `"26.1"` feature support to `["26.1", "26.3"]` in
   `prismarine-physics/lib/features.json`
8. verifies `require('minecraft-data')('26.3')`, `prismarine-registry`, the
   mineflayer version gate, the prismarine-chunk lookup and the physics
   feature check actually pass — install fails loudly otherwise

Steps 4–7 patch **installed dependencies**, not source files in this repo, and
are pure version-list/alias extensions. No behavioral code is modified. If any
upstream anchor disappears (dependency upgrade), the script logs a warning or
dies loudly with the anchor name — never silently.

## Known limitations of this setup

- The 26.3 data is **unmerged PR output**, not an official release. Format
  drift is possible until upstream lands.
- Chat component / NBT edge shapes, chunk biome/light handling, and physics
  minutiae for 26.3 are best-effort clones of the 26.1 behavior. Java 26.3
  against a live server has not been smoke-tested from this sandbox (no route
  to the server from here).
- `MC_VERSION` may be left empty to auto-detect (server lists its version in
  the handshake) — recommended — while 26.3 remains unofficial.

## When to remove this

When upstream merges the PR series and a new `minecraft-data` release with
pc/26.3 lands on npm: bump the dependency, delete `vendor/`, this file, and
`scripts/apply-26.3-data.js`, and drop the `postinstall` hook.
