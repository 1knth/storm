import { useEffect, useMemo, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
import { parseChartData } from './chartData';
import type { Appearance } from '../../appearance';
import { rgbaColor } from '../../appearance';

Chart.register(...registerables);

type Props = { source: string; appearance: Appearance };

export default function NumericChart({ source, appearance }: Props) {
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
          const color = rgbaColor(
            appearance.chartSeries[index % appearance.chartSeries.length],
            appearance.opacity[
              `chartSeries-${(index % appearance.chartSeries.length) + 1}`
            ],
          );
          return {
            label: series.title ?? `Series ${index + 1}`,
            data: series.data,
            backgroundColor: isRadial
              ? parsed.labels.map((_, i) =>
                  rgbaColor(
                    appearance.chartSeries[i % appearance.chartSeries.length],
                    appearance.opacity[
                      `chartSeries-${(i % appearance.chartSeries.length) + 1}`
                    ],
                  ),
                )
              : color,
            borderColor: isRadial
              ? rgbaColor(
                  appearance.mermaidBackground,
                  appearance.opacity.mermaidBackground,
                )
              : color,
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
            labels: {
              color: rgbaColor(
                appearance.chartText,
                appearance.opacity.chartText,
              ),
            },
          },
          title: {
            display: Boolean(parsed.title),
            text: parsed.title,
            color: rgbaColor(
              appearance.chartText,
              appearance.opacity.chartText,
            ),
          },
        },
        scales: isRadial
          ? undefined
          : {
              x: {
                ticks: {
                  color: rgbaColor(
                    appearance.chartText,
                    appearance.opacity.chartText,
                  ),
                },
                grid: {
                  color: rgbaColor(
                    appearance.chartGrid,
                    appearance.opacity.chartGrid,
                  ),
                },
              },
              y: {
                beginAtZero: true,
                ticks: {
                  color: rgbaColor(
                    appearance.chartText,
                    appearance.opacity.chartText,
                  ),
                },
                grid: {
                  color: rgbaColor(
                    appearance.chartGrid,
                    appearance.opacity.chartGrid,
                  ),
                },
              },
            },
      },
    });

    return () => chart.destroy();
  }, [parsed, appearance]);

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
