# Build Resources

This directory contains resources used by electron-builder for packaging the application.

## Icons

To add custom app icons, place the following files in this directory:

- `icon.icns` - macOS icon (multiple sizes, recommended 512x512 minimum)
- `icon.ico` - Windows icon (multiple sizes, recommended 256x256 minimum)
- `icon.png` - Linux icon (recommended 512x512)

If these files are not present, electron-builder will use the default Electron icon.

### Generating Icons from SVG

You can generate icons from the project's SVG logo using tools like:

- **macOS**: `iconutil` or online converters
- **Windows**: `icofx` or online converters  
- **Linux**: `inkscape` or `imagemagick`

Example using ImageMagick:
```bash
# Generate PNG from SVG
convert -background none -resize 512x512 ../app/public/logo.svg icon.png

# Generate ICO from PNG
convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

## macOS Entitlements

`entitlements.mac.plist` - Code signing entitlements for macOS hardened runtime.
