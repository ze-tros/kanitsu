# Kanitsu icon assets

The production icon is a deterministic SVG reconstruction of the selected layered archive-card concept.

## Source files

- `kanitsu-icon.svg`: full application icon with a transparent exterior.
- `kanitsu-icon-foreground.svg`: foreground-only artwork for Android adaptive icons.

## Generated files

Run from the repository root:

```text
npm run generate:icons
```

The generator exports the 1024 px PNG, multi-resolution Windows ICO, Web favicon, density-aware Android adaptive foreground and legacy launcher icons, adaptive-icon XML, and a small-size preview sheet.

## Palette

- Background: `#181A1F`
- Front card: `#E7E3D9`
- Middle card: `#68749A`
- Rear card: `#C8C1B4`
- Index tab: `#C46B5C`
