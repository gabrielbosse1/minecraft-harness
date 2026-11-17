# Native Minecraft renderer

This is the final report for the renderer rewrite: how `zincai/vision.js` obtains
and loads real Minecraft resources, which client rendering definitions it
supports, how transparency and fullbright work, how skins (including
SkinRestorer) are resolved, which object categories render, which tests ran, and
what is still missing.

The public `screenshot()` API is unchanged: `look`, `panorama`, and `map` still
return the same PNG/summary shape used by `perception.js`, `observe.js`,
`vision_navigation.js`, and `visual_feed`. New result fields are additive
(`renderer`, `fullbright`, `assetsVersion`, `assetSources`, `texturesLoaded`,
`skins`, `unsupportedEntities`).

---

## 1. Asset acquisition

`zincai/native/assets.js` discovers real client resources and applies resource
packs with vanilla precedence (later packs override earlier ones):

1. `ZINC_ASSETS_DIR` / `assetsDir` — an explicit extracted directory.
2. Extracted client resources shipped by `prismarine-viewer`:
   `node_modules/prismarine-viewer/public/textures/<version>/` (`blocks/*.png` +
   `.mcmeta`, `blocks_states.json`, `blocks_models.json`, `items/`, `colormap/`,
   `entity/**`, `particle/`, `font/`, `environment/`, `map/`). The version is the
   live `bot.version`; if that exact directory is absent the nearest version is
   used and the summary records `requested X; nearest extracted client resources
   are Y`.
3. `minecraft-assets` npm layout, if installed.
4. A real client install:
   - `ZINC_MC_JAR=/path/to/1.21.4.jar` (or the normal
     `.minecraft/versions/<v>/<v>.jar`) read directly as a ZIP, including
     `assets/minecraft/{blockstates,models,textures}`;
   - `.minecraft/assets` via `ZINC_MC_ASSETS`/`MINECRAFT_HOME`, resolved through
     the real asset-index JSON object store.
5. Extra resource packs from `resourcePacks` / `ZINC_RESOURCE_PACKS`
   (path-delimited; directories, `.zip`, or `.jar`), overlaid last.

Asset files are looked up by their real resource names only. There is no
name→texture table, no random mapping, and no procedural block texture
generation. Blocks that do not exist in the loaded version (e.g. 26.3 data on a
1.21.4 asset set) are reported as missing rather than silently invented.

`native/png.js` is a small PNG decoder that preserves exact RGBA, supports
colour types 0/2/3/4/6 at bit depths 1/2/4/8/16, tRNS, and parses `.mcmeta`
animation descriptors. Palette decoding matters: most vanilla 16×16 block
textures are 4-bit palette PNGs — decoding them as greyscale was what made oak
planks and cherry logs nearly black in the first pass.

## 2. Blockstate → model → texture resolution

`native/blockModels.js` implements the client model pipeline:

- `variants`: property matching with the most specific key, weighted variant
  lists, and X-then-Y variant rotation (`y`, `x`, `uvlock`);
- `multipart`: `when` conditions including `|` alternatives and `OR`/`AND`
  groups (fences, panes, walls, redstone, stairs rails), applied incrementally;
- model inheritance through `parent` chains, with texture/element/`shade`/
  `ambientocclusion` merging;
- elements: `from`/`to`, all six faces, explicit `uv` rectangles or the vanilla
  default UV per face, `rotation` (including rescale) and `cullface`;
- texture references (`#name` chains, `minecraft:` namespace, `blocks/` paths),
  `tintindex`, and `particle` fallback references;
- `uvlock` applied as a rotation of the four UV pairs (rotating rectangle bounds
  produced NaNs);
- full-cube detection only for a genuine full 0..16 element and a single
  variant entry; neighbour occlusion/culling uses real neighbour states;
- biome tints from the real `colormap/grass.png`/`foliage.png` and `tints.json`
  overrides (grass/foliage/water/redstone/stems/lily pad).

Special client renderers that are not block models are handled explicitly:
fluids (`water`, `lava`; the real still textures, level height, biome water tint,
same-fluid face culling) and chests (`chest`, `trapped_chest`, `ender_chest`;
body/lid/latch with the real 64×64 chest texture and facing rotation).

## 3. Transparency and depth

No blanket transparency and no disabled depth test. Render layers come from the
model/material and the texture alpha:

| layer | example | behaviour |
| --- | --- | --- |
| `opaque` | stone, planks, grass | depth-writing, face-shaded, contact AO |
| `cutout_mipped` | glass block frame, leaves, plants, doors, panes, iron bars, torches | alpha test at `< 26/255`; surviving texels are opaque and depth-write |
| `translucent` | water, ice (alpha 190), stained glass (alpha 102/155), slime, tinted glass | alpha-composited front-to-back over the opaque/sky result; up to 8 translucent surfaces per ray; no opaque depth write from the translucent surface |

Cutout holes are real holes: the ray continues through transparent texels and
hits whatever is behind (verified in test 10b against a stone wall). Vanilla
half-transparent materials are kept, not discarded: `ice` (alpha 190) and
`water` (alpha 180) survive alpha testing and composite. Glass's mostly-zero
interior and opaque border render as the familiar frame.

Faces are culled with `cullface` against real neighbours and full opaque cubes;
fluid faces are culled only against the same fluid. Blocks are not treated as
generic cubes: a cherry sapling, fence, slab, stair, pane, torch, flower, chest
and grass block each resolve to their own elements. Entity quads are rasterized
into the same z-buffer after the block pass (opaque/cutout first, then
translucent sorted far-to-near).

`map` renders a top-down surface view by sampling the real top-face UV of each
surface model (and an alternate model texture for transparent tops), not by
painting invented colours.

## 4. Permanent fullbright

Fullbright is implemented in the shading stage, not by editing the world:

- no skylight, blocklight, day/night factor, or nearby-light dependence is read
  while shading;
- the only light terms are vanilla-style directional face constants
  (`up 1.0`, `north/south 0.8`, `east/west 0.6`, `down 0.5`) and a gentle
  contact AO floor of `0.78` for corners;
- therefore the same stone/wood/leaf pixel is identical at noon, midnight, and
  in a sealed cave, while the sky still has its day/night/twilight/nether/end
  appearance.

This changes only rendering. `environment.js`, `observe.js`, torches, cave
lighting, spawn-proofing, and every gameplay lighting rule are untouched; the
bot's summaries still report the real block/sky light values (e.g.
`block light 0/15 | sky light 15/15`).

## 5. Player models and skins (including SkinRestorer)

`native/entityModels.js` builds geometry from prismarine-viewer's
`viewer/lib/entity/entities.json` (the exact vanilla `EntityModel` layers: bones,
pivots, cuboids, per-cube UVs, inflate, overlay layers), using the client cube UV
layout and a model-unit → block transform. Bones apply their own bind rotation;
animation deltas accumulate down the chain; the walk cycle drives legs/arms and
players/mobs turn their head toward their pitch.

Players use the real 64×64 player model: head, body, arms, legs, plus hat,
jacket, sleeves and pants overlay layers. Classic arms are 4 px and slim arms
are 3 px. Skin alpha is preserved (transparent overlay texels are cut out).
Texture pixel UVs are normalised against the actual image size, which fixes the
64×32 skins that are padded to 64×64 (zombie) and models that omit their nominal
texture size.

Skins come from the **effective client-side skin property**:

- `bot.players[name].skinData` first — mineflayer parses the player-info
  `textures` property, so a SkinRestorer replacement arrives here;
- fallback: raw base64 `properties` (`textures.SKIN.url` + `metadata.model`);
- the renderer downloads exactly that URL (or reads `file://`/local paths); it
  never resolves Mojang's original profile and never overrides a replacement;
- cache key is `sha1(url|model)` in `data/skins/`; a changed URL/model creates a
  new revision, invalidates the old texture and is visible on the next frame
  without restarting the renderer. New players appear on the next frame;
- local `<uuid>.png` / `<name>.png` overrides under the skin cache or
  `ZINC_SKIN_OVERRIDES` are supported for pinned skins;
- legacy 64×32 skins are upgraded like the client's `LegacySkinAdapter`
  (mirrored right arm/leg into the modern left limb regions);
- if no texture is available the vanilla `wide/steve` or `slim/alex` skin from
  the real client resources is used, and the report says so.

The summary's `skins:` line and `result.skins` list `username`,
`model`, `source` (`network`/`cache`/`local-override`/`vanilla-default`),
`profileSource` (`player_info.textures` / `profile.properties.textures`) and the
revision hash.

## 6. Items

Items are models, not blocks. `zincai/native/items.js` resolves the same
`assets/minecraft/models/item/<item>.json` chain the client loads
(`item/handheld` → `item/generated` → `builtin/generated`, or a `block/...`
parent). Because the prismarine extraction ships only flattened item textures,
the 1.21.4 item-model JSONs are vendored in
`zincai/native/item-models-1.21.4.json` (1,076 models, 151 KB, generated
from the `misode/mcmeta` `1.21.4-assets` tag). A resource-pack or official-jar
item model is used first when present.

Geometry is the client's actual rule:

- `item/generated` has no JSON elements. The renderer runs the equivalent of
  `ItemModelGenerator`: it scans the real 16×16 sprite and extrudes each opaque
  pixel run into a one-pixel-thick cuboid (front, back, and only the exposed
  side faces). Multi-layer sprites (potion `layer0` + `layer1`) are stacked.
- Block items use the block's default-state model from `BlockModelStore`
  (`stone`, `oak_planks`, `oak_stairs`, saplings, torches, ...).
- The real `display` transforms (`ground`, `thirdperson_righthand`,
  `firstperson_righthand`) are applied, including Y/X/Z rotation order,
  1/16-block translations and scale.
- Item textures use the same alpha-aware atlas as blocks (cutout, or translucent
  when the sprite has semi-transparent pixels).

What is drawn:

- **Dropped item entities** (`entity.getDroppedItem()`), spinning with the
  vanilla ground display transform and reported as `items in frame: ...`.
- **Main-hand equipment of players and mobs** (`entity.equipment[0]` /
  `entity.heldItem`), attached to the right arm and rotated by the arm pose.
- **The bot's own held item**, using the real first-person display transform as
  a camera-space overlay (`selfHeldItem` in the result). No hand/arm mesh is
  drawn for the overlay.

Coverage across the 1.21.4 registry: **1,263 of 1,384 items** draw (1,260 with
a real item model or block model, plus compass/recovery compass/clock using
their real north/noon frame as a reported static fallback). 40 builtin entity
items are reported unsupported, and 81 spawn eggs have no drawable model
because vanilla applies their colours in code, not in client resources.

`itemsSeen`, `itemNames`, `selfHeldItem`, `heldItems` and `unsupportedItems`
are additive result fields. Items without a drawable model (shield, beds,
chests, banners, skulls, conduit, decorated pot, spyglass-in-hand) are counted
in `unsupportedItems` and named in the summary instead of being approximated.

## 7. Object coverage

Rendered from real definitions: terrain and every blockstate variant present in
the loaded version (logs, planks, leaves, grass, dirt, ores, bricks, etc.),
cherry trees/leaves/logs and other vegetation, flowers/crops/cross models, slabs,
stairs, fences, walls, panes, doors, trapdoors, ladders, torches, glass and
stained glass, water/lava, chests, and real entity models for players and the
supported mobs (cow, pig, zombie, skeleton, creeper, chicken, spider, enderman,
villager, etc. — anything with an entry in `entities.json` and a texture).

Known gaps are listed in §9; they are reported in the summary rather than hidden.

## 8. Tests actually run

```bash
npm install --no-audit --no-fund
node --test test/09-screenshot-vision-and-logging.test.js \
           test/10-native-renderer.test.js \
           test/11-native-renderer-real-server.test.js
```

Result: **16/16 passing** on 2026-11-17. The whole repository suite
(`npm test`, every `test/*.test.js` file, 8 suites) also passes: **80/80**.

- `09a` (rewritten): real client resources discovered; palette PNG decode;
  glass alpha histogram; blockstate/model resolution for stairs, grass,
  leaves, water; render layers (`opaque` / `cutout_mipped` / `translucent`);
  fluid surface height; plains/cherry-grove tints from colormap + `tints.json`;
  classic vs slim arm UVs; zero missing textures.
- `09b`: real flying-squid world; look/panorama/map, chunk coverage, budgets.
- `09c`–`09e`: runtime screenshot tool, telemetry archives, navigation overlays,
  live viewer streaming (unchanged APIs still pass).
- `10a` cherry grove look/panorama/map, summary, asset metadata, budgets.
- `10b` cherry-leaf cutout holes reveal the stone wall behind.
- `10c` noon vs midnight: opaque terrain pixels byte-identical (max delta 0–1)
  while the sky darkens.
- `10d` custom red skin → blue skin via changed server texture URL: correct
  pixels, model change (wide→slim), revision change, no stale skin.
- `10e` SkinRestorer-style raw base64 texture property without `skinData`.
- `10f` legacy 64×32 skin upgrade.
- `10g` translucent water/stained-glass compositing.
- `10h` cow + zombie + player models rasterize into the frame and are reported.
- `10i` animated `.mcmeta` textures advance; a real resource pack overrides a
  blockstate and texture.
- `10j` real item models: generated diamond sword extrusion, block items
  (`oak_planks`, `oak_stairs`, `stone`), `shield` reported as unsupported,
  dropped item entity, zombie main-hand pickaxe, bot first-person apple, and
  cyan sword pixels instead of a missing-texture checkerboard.
- `11` real server: real chunks, cow/zombie, chest, glass, water, stairs, cherry
  leaves, poppy, panorama and map.

Manual probe results that drove the alpha decisions: `glass` `{0:191, 255:65}`,
`cherry_leaves` `{0:40, 255:216}`, `water_still` alpha 180 (16×512, 32 frames),
`ice` alpha 190, `red_stained_glass` `{102:191, 155:5, 163:60}`,
`tinted_glass` `{110:20, 255:236}`, `oak_planks` palette decode
`≈(162,131,79)`.

For a visual check without a server, `node scripts/render-samples.js` builds a
small synthetic cherry-grove/greenhouse scene through the same pipeline and
writes `look.png`, `panorama.png` and `map.png` to
`.zinc-test-run/renders/` (git-ignored). The look sample should show real
cherry leaves with cutout holes, a translucent greenhouse, blue water, a
recognisable cow and a zombie with the vanilla arms-forward pose.

Performance on this machine (real server, 1.21.4 resources): look 512×288
≈0.6 s, panorama 720×200 ≈0.4 s, map 33×33 ≈0.1–0.3 s — well inside the
existing 4 s / 4 s / 1.5 s budgets. The renderer remains pure JS, no new
dependencies.

## 9. Remaining limitations (not hidden)

1. **Signs, beds, skulls, banners and hanging signs.** The bundled
   `prismarine-viewer` model extraction is missing the `template_sign`,
   `template_hanging_sign` and bed `builtin/entity` models, and these are
   special renderers rather than block models. They currently fall back to a
   cube using the block's own particle texture and are labelled
   `fallback:<block>` in the summary. Pointing `ZINC_MC_JAR` at an official
   client jar would supply any JSON models the extraction lacks, but the
   special renderers themselves (sign board/text, bed halves, skulls) are still
   future work.
2. **Sheep.** The bundled `entities.json` sheep UVs expect a 64×64 sheet
   (`uv` at y=32..54) while the 1.21.4 resource pack ships a 64×32
   `sheep_fur.png`; the sheep texture therefore samples the wrong region. Cow,
   pig, chicken, zombie, skeleton, creeper, spider, enderman, villager and
   player models were checked. This is a resource/version mismatch, not a
   colour tweak.
3. **Item gaps.** Dropped items, main-hand equipment and the bot's own held
   item render; armour, off-hand items, item frames (block-entity inventory is
   not exposed by prismarine-chunk), chest/shulker contents, enchantment glint,
   durability bars, stack counts and `custom_model_data`/`overrides` predicates
   are not drawn. Builtin entity items (shield, bed, chest, banner, skull,
   conduit, decorated pot) are reported as unsupported rather than faked, as
   are the 81 spawn eggs whose tints only exist in vanilla code. Compasses and
   clocks use a real static frame and are labelled `static-frame:<frame>`.
   Mineflayer emits particles as events and the harness does not keep a particle
   ring buffer, so world particles are not drawn. Entity animation is likewise limited to the idle
   humanoid arm poses (zombie/skeleton arms forward), leg/arm walk swing, head
   pitch and yaw; there is no vanilla animation-state machine (eating, attacking,
   sleeping, riding, baby scaling).
4. **Capes** are not rendered (cape URL is parsed and reported, but the cape
   geometry/texture layer is not attached).
5. **Sky, sun/moon, stars and clouds** remain the renderer's own sky model
   (day/night/twilight/nether/end gradients), not resource-pack textures.
6. **`minecraft-assets` npm** is deliberately not added (1.19, ~142 MB); the
   bundled prismarine extraction and an official jar/asset index are used
   instead.
7. Interlaced PNGs are not supported; vanilla textures are non-interlaced.
8. The renderer does not implement vanilla PBR, shadows, translucency sorting
   beyond per-ray/per-entity ordering, or the lightmap; fullbright is the
   intended lighting mode.
9. Assets and data versions can differ (bot on 1.21.4, vendored block data
   26.3). Blocks absent from the asset version are reported instead of being
   silently mapped.
