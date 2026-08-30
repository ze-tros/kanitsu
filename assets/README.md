# Kanitsu icon assets

`kanitsu-icon.svg` is the canonical vector source for the Kanitsu application icon. It is a hand-redrawn vector interpretation of the selected three-layer card composition: a transparent canvas, warm ivory back card, blue middle card, cream front card, and coral accent tab.

`kanitsu-icon-source.png` is retained as the original raster reference supplied during the icon design process. It is not used by the generator.

## Generate derived assets

Run from the repository root:

```text
npm run generate:icons
```

The generator rasterizes the SVG source into the 1024 px application PNG, multi-resolution Windows ICO, Web favicon and Apple touch icon, density-aware Android launcher/adaptive foreground images, adaptive-icon XML, and a small-size preview sheet. All generated platform assets are derived from the same vector source so they remain visually consistent and preserve transparent pixels outside the artwork.
