import type { ReactNode } from 'react';

/** Shared choice control for questions and next-step prompts. */
export default function QuizChoice({
  name,
  checked,
  disabled,
  onChange,
  children,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label className="quiz-choice-card">
      <input
        className="quiz-choice-radio"
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="quiz-agent-markdown min-w-0">{children}</span>
    </label>
  );
}
