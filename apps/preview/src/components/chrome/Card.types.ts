import type { ComponentPropsWithoutRef } from 'react';

export interface CardData {
  id: number;
  colorClass: string;
  date: string;
  title: string;
  description: string;
  progressPercent: string;
  progressValue: string;
  progressLabel?: string;
  imgSrc1?: string;
  imgAlt1?: string;
  imgSrc2?: string;
  imgAlt2?: string;
  countdownText: string;
}

export interface CardProps extends ComponentPropsWithoutRef<'div'> {
  data: CardData;
}
