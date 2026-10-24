# Stickers

The sticker packs the story editor's picker offers, and each person's recently used stickers.

```ts
const stickers = new StickersModule(config, team, stories);
```

Packs live in `<agent home>/stickers`, which Config owns. The daemon ships none: nothing from a
pack is in the package, the binary, or the installer, and tests use tiny generated packs.

```text
<agent home>/stickers/
├── order.json            optional: pack IDs in picker order; the rest follow by title
└── <packId>/
    ├── pack.json         id (= folder name), title, kind, thumbnail, stickers[]
    └── <files>           each listed with its size and sha256
```

The catalog is read on first use and again whenever the folder's stamp — every manifest's
modification time and size, and `order.json`'s — changes. A pack whose manifest does not
validate, names another folder, or lists a file whose size or digest differs is left out.

`file(ctx, packId, stickerId, lottie)` serves a sticker's file; with `lottie`, a `tgs` sticker is
gunzipped once into `<agent home>/cache/stickers/<sha256>.json` and served from there.

Search matches an emoji tag, ignoring skin tones and variation selectors, or a word prefix of a
pack's title. Recents are kept per person, at most 20, most recent first; posting a story records
every sticker on it through Stories' posted listener. Stickers follow the Stories setting.
