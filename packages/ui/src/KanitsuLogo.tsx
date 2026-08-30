import type { ImgHTMLAttributes } from 'react';

const KANITSU_ICON_SRC = './favicon.png';

type KanitsuLogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>;

/** Reusable application mark backed by the public Kanitsu raster icon. */
export function KanitsuLogo({ draggable = false, ...props }: KanitsuLogoProps) {
  return <img {...props} src={KANITSU_ICON_SRC} draggable={draggable} />;
}
