export type TagTabAction =
  | { type: "add"; index: number }
  | { type: "highlight"; index: number }
  | { type: "default" };

// Tab completes a typed tag: with one suggestion it adds that tag, with
// several it cycles the highlight (Shift+Tab backwards). With nothing typed,
// the menu closed, or no suggestions, Tab keeps moving focus as usual.
export function tagTabAction({
  highlight,
  menuOpen,
  shift,
  suggestionCount,
  text,
}: {
  highlight: number;
  menuOpen: boolean;
  shift: boolean;
  suggestionCount: number;
  text: string;
}): TagTabAction {
  if (!menuOpen || !text.trim() || suggestionCount === 0) {
    return { type: "default" };
  }
  if (suggestionCount === 1) {
    return { type: "add", index: 0 };
  }

  const step = shift ? -1 : 1;
  return { type: "highlight", index: (highlight + step + suggestionCount) % suggestionCount };
}
