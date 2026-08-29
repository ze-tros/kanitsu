import type { ImgHTMLAttributes } from 'react';

const KANITSU_ICON_SRC = './favicon.svg';

type KanitsuLogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>;

/** Reusable application mark backed by the public Kanitsu favicon asset. */
export function KanitsuLogo({ draggable = false, ...props }: KanitsuLogoProps) {
  return <img {...props} src={KANITSU_ICON_SRC} draggable={draggable} />;
}