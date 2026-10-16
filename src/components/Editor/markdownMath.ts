import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export const markdownMathRemarkPlugin = [
  remarkMath,
  { singleDollarTextMath: true },
] as [typeof remarkMath, { singleDollarTextMath: boolean }];

export const markdownMathRehypePlugin = [
  rehypeKatex,
  {
    trust: false,
    strict: 'warn' as const,
    throwOnError: false,
    maxExpand: 1000,
    maxSize: 10,
  },
] as [
  typeof rehypeKatex,
  {
    trust: boolean;
    strict: 'warn';
    throwOnError: boolean;
    maxExpand: number;
    maxSize: number;
  },
];
