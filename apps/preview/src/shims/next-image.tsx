import type { ImgHTMLAttributes } from 'react';

type ImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  sizes?: string;
  fill?: boolean;
};

export default function Image({ src, alt, className, width, height, ...props }: ImageProps) {
  const { sizes, fill, ...rest } = props;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      width={width}
      height={height}
      {...rest}
    />
  );
}
