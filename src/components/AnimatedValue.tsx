import { money } from '../../shared/analytics.ts';

interface Props {
  value: number | null | undefined;
  format?: (value: number) => string;
  fallback?: string;
  className?: string;
}

export default function AnimatedValue({ value, format = money, fallback = 'Not recorded', className }: Props) {
  const known = typeof value === 'number' && Number.isFinite(value);
  return <span className={['animated-value', className].filter(Boolean).join(' ')} data-live-value={known ? value : 'unknown'}>{known ? format(value) : fallback}</span>;
}
