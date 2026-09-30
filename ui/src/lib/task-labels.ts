import type { LabelCount, LabelMatchMode } from "../domain/types";

export function parseTaskLabels(input: string) {
  return normalizeLabelList(input.split(","));
}

// Trims labels, drops empty ones, and removes exact duplicates in first-seen order.
export function normalizeLabelList(input: string[]) {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const part of input) {
    const label = part.trim();
    if (!label || seen.has(label)) {
      continue;
    }

    labels.push(label);
    seen.add(label);
  }

  return labels;
}

export function formatTaskLabels(labels: string[]) {
  return parseTaskLabels(labels.join(",")).join(", ");
}

export function taskLabelsEqual(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((label, index) => label === right[index]);
}

// Mirrors the API's label filter: exact, case-sensitive matches on trimmed labels.
export function taskMatchesLabels(taskLabels: string[], selected: string[], mode: LabelMatchMode) {
  if (selected.length === 0) {
    return true;
  }

  const labels = new Set(normalizeLabelList(taskLabels));
  return mode === "any"
    ? selected.some((label) => labels.has(label))
    : selected.every((label) => labels.has(label));
}

// Counts each distinct label across tasks, sorted the way `GET /api/labels` sorts.
export function countTaskLabels(tasks: Array<{ labels: string[] }>): LabelCount[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    for (const label of normalizeLabelList(task.labels)) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => compareLabels(left.label, right.label));
}

function compareLabels(left: string, right: string) {
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  if (lowerLeft !== lowerRight) {
    return lowerLeft < lowerRight ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}
