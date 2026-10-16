import { useEffect, useMemo, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
import { parseChartData } from './chartData';

Chart.register(...registerables);

const COLORS = [
  '#38bdf8',
  '#f472b6',
  '#a3e635',
  '#fbbf24',
  '#a78bfa',
  '#fb7185',
  '#2dd4bf',
  '#c084fc',
];

type Props = { source: string };

export default function NumericChart({ source }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => {
    try {
      return { data: parseChartData(source), error: '' };
    } catch (parseError) {
      return {
        data: null,
        error:
          parseError instanceof Error
            ? parseError.message
            : 'Invalid chart data.',
      };
    }
  }, [source]);
  const { data: parsed, error } = result;

  useEffect(() => {
    if (!canvas.current || !parsed) return;

    const isRadial = parsed.type === 'pie' || parsed.type === 'doughnut';
    const chart = new Chart(canvas.current, {
      type: parsed.type,
      data: {
        labels: parsed.labels,
        datasets: parsed.series.map((series, index) => {
          const color = COLORS[index % COLORS.length];
          return {
            label: series.title ?? `Series ${index + 1}`,
            data: series.data,
            backgroundColor: isRadial
              ? parsed.labels.map((_, i) => COLORS[i % COLORS.length])
              : color,
            borderColor: isRadial ? '#111827' : color,
            borderWidth: isRadial ? 2 : 2,
            ...(parsed.type === 'line'
              ? { tension: 0.25, pointRadius: 3 }
              : {}),
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: {
            display: parsed.type !== 'bar' || parsed.series.length > 1,
            position: isRadial ? 'bottom' : 'top',
            labels: { color: '#d1d5db' },
          },
          title: {
            display: Boolean(parsed.title),
            text: parsed.title,
            color: '#f3f4f6',
          },
        },
        scales: isRadial
          ? undefined
          : {
              x: { ticks: { color: '#9ca3af' }, grid: { color: '#ffffff18' } },
              y: {
                beginAtZero: true,
                ticks: { color: '#9ca3af' },
                grid: { color: '#ffffff18' },
              },
            },
      },
    });

    return () => chart.destroy();
  }, [parsed]);

  if (error)
    return (
      <p className="my-3 rounded bg-white/5 p-3 text-xs text-rose-300">
        Chart error: {error}
      </p>
    );
  if (!parsed) return null;

  return (
    <div className="my-4 h-64 w-full max-w-full rounded-lg bg-black/20 p-3">
      <canvas
        ref={canvas}
        role="img"
        aria-label={parsed.title ?? `${parsed.type} chart`}
      />
    </div>
  );
}
