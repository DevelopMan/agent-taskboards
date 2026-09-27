const promptPickerVisibilityStorageKey = "taskboards.task.promptPickerVisible";

export function storedPromptPickerVisible(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    return window.localStorage.getItem(promptPickerVisibilityStorageKey) !== "false";
  } catch {
    return true;
  }
}

export function persistPromptPickerVisible(visible: boolean) {
  try {
    window.localStorage.setItem(promptPickerVisibilityStorageKey, String(visible));
  } catch {
    // Preference persistence should never block the task UI.
  }
}
